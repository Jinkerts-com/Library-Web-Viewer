import fs from 'fs';
import path from 'path';
import { libraryPath } from '../../lib/db';
import type { APIRoute } from 'astro';
import { getPlaceholderResponse } from '../../lib/placeholder';
import { getMimeType } from '../../lib/mime';

export const GET: APIRoute = async ({ params, request }) => {
    if (!libraryPath || !params.path) {
        return getPlaceholderResponse();
    }

    let imagePathRelative: string;
    try {
        imagePathRelative = decodeURIComponent(params.path);
    } catch (e) {
        return new Response("Invalid path", { status: 400 });
    }

    // Sanitize path to prevent traversal: resolve and require the result to
    // stay strictly inside the library's images root
    const imagesRoot = path.resolve(libraryPath, "images");
    const fullPath = path.resolve(imagesRoot, imagePathRelative);
    if (!fullPath.startsWith(imagesRoot + path.sep)) {
        console.log(`[IMG ERR] Traversal detected: ${imagePathRelative}`);
        return new Response("Invalid path", { status: 403 });
    }

    if (!fs.existsSync(fullPath)) {
        // Context: 'images/ID.info/NAME.EXT'
        // Try to recover by scanning the folder
        const parts = imagePathRelative.split('/');
        if (parts.length >= 2) {
            const infoFolder = parts[0]; // ID.info
            // Verify it looks like an info folder
            if (infoFolder.endsWith('.info')) {
                const dirPath = path.join(imagesRoot, infoFolder);
                if (fs.existsSync(dirPath)) {
                    try {
                        const files = fs.readdirSync(dirPath);
                        // Find a file that is NOT metadata.json and NOT a thumbnail
                        const actualFile = files.find(f =>
                            f !== 'metadata.json' &&
                            !f.includes('_thumbnail')
                        );

                        if (actualFile) {
                            const recoveredPath = path.join(dirPath, actualFile);

                            // Serve this file instead
                            const stat = fs.statSync(recoveredPath);
                            const fileSize = stat.size;
                            const fileBuffer = await fs.promises.readFile(recoveredPath);

                            const contentType = getMimeType(path.extname(recoveredPath));

                            return new Response(fileBuffer, {
                                headers: {
                                    "Content-Type": contentType,
                                    "Content-Length": fileSize.toString()
                                }
                            });
                        }
                    } catch (e) {
                        console.error("[IMG RECOVERY] Error scanning", e);
                    }
                }
            }
        }

        return getPlaceholderResponse();
    }

    try {
        const stat = fs.statSync(fullPath);
        const fileSize = stat.size;
        const contentType = getMimeType(path.extname(fullPath));

        // Range Request Handling
        const range = request.headers.get('range');
        const rangeMatch = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = rangeMatch[2] ? Math.min(parseInt(rangeMatch[2], 10), fileSize - 1) : fileSize - 1;

            if (start >= fileSize || start > end) {
                return new Response(null, {
                    status: 416,
                    headers: { "Content-Range": `bytes */${fileSize}` }
                });
            }

            const chunksize = (end - start) + 1;
            const fileStream = fs.createReadStream(fullPath, { start, end });

            // @ts-ignore - ReadableStream/NodeStream mismatch fix
            return new Response(fileStream, {
                status: 206,
                headers: {
                    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                    "Accept-Ranges": "bytes",
                    "Content-Length": chunksize.toString(),
                    "Content-Type": contentType,
                }
            });
        } else {
            // No Range header, or one we can't parse (e.g. suffix ranges):
            // serve the full file
            const fileBuffer = await fs.promises.readFile(fullPath);
            return new Response(fileBuffer, {
                headers: {
                    "Content-Type": contentType,
                    "Content-Length": fileSize.toString(),
                    "Accept-Ranges": "bytes"
                }
            });
        }
    } catch (error) {
        console.error("Image serve error:", error);
        return getPlaceholderResponse();
    }
}
