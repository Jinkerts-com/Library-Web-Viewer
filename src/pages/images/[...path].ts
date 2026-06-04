import fs from 'fs';
import path from 'path';
import { libraryPath } from '../../lib/db';
import type { APIRoute } from 'astro';
import { getPlaceholderResponse } from '../../lib/placeholder';

export const GET: APIRoute = async ({ params, request }) => {
    const imagePathRelative = params.path ? decodeURIComponent(params.path) : null;

    // DEBUG LOG
    // console.log(`[IMG REQ] Raw params.path: ${params.path}`);
    // console.log(`[IMG REQ] Decoded Relative: ${imagePathRelative}`);

    if (!libraryPath || !imagePathRelative) {
        // console.log(`[IMG ERR] Missing library path or relative path`);
        return getPlaceholderResponse();
    }

    // Sanitize path to prevent traversal (basic check)
    if (imagePathRelative.includes('../') || imagePathRelative.includes('..\\')) {
        console.log(`[IMG ERR] Traversal detected: ${imagePathRelative}`);
        return new Response("Invalid path", { status: 403 });
    }

    const fullPath = path.join(libraryPath, "images", imagePathRelative);
    // console.log(`[IMG REQ] Resolved Full Path: ${fullPath}`);

    if (!fs.existsSync(fullPath)) {
        // console.log(`[IMG ERR] File not exist at: ${fullPath}`);

        // Context: 'images/ID.info/NAME.EXT'
        // Try to recover by scanning the folder
        const parts = imagePathRelative.split('/');
        if (parts.length >= 2) {
            const infoFolder = parts[0]; // ID.info
            // Verify it looks like an info folder
            if (infoFolder.endsWith('.info')) {
                const dirPath = path.join(libraryPath, "images", infoFolder);
                if (fs.existsSync(dirPath)) {
                    // console.log(`[IMG RECOVERY] Scanning folder: ${dirPath}`);
                    try {
                        const files = fs.readdirSync(dirPath);
                        // Find a file that is NOT metadata.json and NOT a thumbnail
                        const actualFile = files.find(f =>
                            f !== 'metadata.json' &&
                            !f.includes('_thumbnail')
                        );

                        if (actualFile) {
                            const recoveredPath = path.join(dirPath, actualFile);
                            // console.log(`[IMG RECOVERY] Found alternate: ${recoveredPath}`);

                            // Serve this file instead
                            const stat = fs.statSync(recoveredPath);
                            const fileSize = stat.size;
                            const fileBuffer = await fs.promises.readFile(recoveredPath);

                            // Reuse mime type logic
                            const ext = path.extname(recoveredPath).toLowerCase();
                            const mimeTypes: Record<string, string> = {
                                '.png': 'image/png',
                                '.jpg': 'image/jpeg',
                                '.jpeg': 'image/jpeg',
                                '.gif': 'image/gif',
                                '.webp': 'image/webp',
                                '.mp4': 'video/mp4',
                                '.webm': 'video/webm',
                                '.mp3': 'audio/mpeg',
                                '.wav': 'audio/wav',
                                '.mov': 'video/quicktime',
                                '.m4a': 'audio/mp4'
                            };
                            const contentType = mimeTypes[ext] || 'application/octet-stream';

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

        // MIME Type
        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.mov': 'video/quicktime',
            '.m4a': 'audio/mp4'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        // Range Request Handling
        const range = request.headers.get('range');
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
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
