import fs from 'fs';
import path from 'path';
import type { APIRoute } from 'astro';
import { authorizeItem, type AccessDecision, type AccessDeps } from './itemAccess';
import { resolveOriginal } from './mediaPaths';
import { getPlaceholderResponse } from './placeholder';
import { getMimeType } from './mime';
import { nonThrowingLogger } from './scan';

/**
 * Media route handlers as factories over injected dependencies, so the
 * authorization order (lookup + lock check BEFORE any cache or file access) is
 * testable without the production database.
 */

export interface MediaHandlerDeps {
    access: AccessDeps;
    /** Called before authorization; lets production load lock metadata first. */
    prepare?: () => Promise<void>;
    log?: { error: (...args: any[]) => void };
}

async function authorize(deps: MediaHandlerDeps, request: Request, id: unknown): Promise<AccessDecision> {
    try { await deps.prepare?.(); } catch { /* readiness is re-checked by authorizeItem */ }
    return authorizeItem(deps.access, request, id);
}

function denied(decision: Extract<AccessDecision, { ok: false }>): Response {
    return decision.status === 503
        ? new Response("Service unavailable", { status: 503 })
        : new Response("Not found", { status: 404 });
}

export function createThumbnailHandler(
    deps: MediaHandlerDeps & { generateThumbnail: (id: string) => Promise<Buffer | null> }
): APIRoute {
    const log = nonThrowingLogger(deps.log ?? console);
    return async ({ params, request }) => {
        const decision = await authorize(deps, request, params.id);
        if (!decision.ok) return denied(decision);

        try {
            const buffer = await deps.generateThumbnail(decision.item.id);
            if (!buffer) return getPlaceholderResponse();
            return new Response(buffer as unknown as BodyInit, {
                headers: {
                    "Content-Type": "image/webp",
                    "Cache-Control": "public, max-age=31536000, immutable"
                }
            });
        } catch (error) {
            log.error("[API] thumbnail error:", error);
            return getPlaceholderResponse();
        }
    };
}

export function createPreviewHandler(
    deps: MediaHandlerDeps & { generatePreview: (id: string, ext: string) => Promise<Buffer | null> }
): APIRoute {
    const log = nonThrowingLogger(deps.log ?? console);
    return async ({ params, request }) => {
        const decision = await authorize(deps, request, params.id);
        if (!decision.ok) return denied(decision);

        try {
            const buffer = await deps.generatePreview(decision.item.id, decision.item.ext);
            if (!buffer) return new Response("Preview unavailable", { status: 404 });
            return new Response(new Uint8Array(buffer), {
                status: 200,
                headers: {
                    'Content-Type': 'image/webp',
                    'Cache-Control': 'public, max-age=604800, immutable'
                }
            });
        } catch (error) {
            log.error("[API] preview error:", error);
            return new Response("Internal Server Error", { status: 500 });
        }
    };
}

export function createOriginalHandler(
    deps: MediaHandlerDeps & { getLibraryPath: () => string }
): APIRoute {
    const log = nonThrowingLogger(deps.log ?? console);
    return async ({ params, request }) => {
        const libraryPath = deps.getLibraryPath();
        if (!libraryPath || !params.path) return getPlaceholderResponse();

        // Known limitation (P3.4): the router has usually already decoded params.path,
        // so this is a second decode; a literal "%XX" in a real filename may select the
        // wrong same-item file. P3.4 must encode/decode exactly once.
        // Malformed percent-encoding is 400 (request-syntax dependent, not an existence oracle).
        let relative: string;
        try {
            relative = decodeURIComponent(params.path);
        } catch {
            return new Response("Invalid path", { status: 400 });
        }

        // Exactly "<id>.info/<file>": anything else is not an item original
        const parts = relative.split('/');
        const dirName = parts[0];
        if (parts.length !== 2 || !dirName.endsWith('.info')) return new Response("Not found", { status: 404 });
        const itemId = dirName.slice(0, -'.info'.length);

        const decision = await authorize(deps, request, itemId);
        if (!decision.ok) return denied(decision);

        const resolved = resolveOriginal(libraryPath, decision.item.id, decision.item.ext, parts[1]);
        if (resolved.kind === 'ambiguous') return new Response("Ambiguous original", { status: 409 });
        if (resolved.kind !== 'ok') return new Response("Not found", { status: 404 });

        try {
            const fileSize = fs.statSync(resolved.path).size;
            const contentType = getMimeType(path.extname(resolved.path));

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

                // @ts-ignore - ReadableStream/NodeStream mismatch fix
                return new Response(fs.createReadStream(resolved.path, { start, end }), {
                    status: 206,
                    headers: {
                        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                        "Accept-Ranges": "bytes",
                        "Content-Length": ((end - start) + 1).toString(),
                        "Content-Type": contentType,
                    }
                });
            }

            // No Range header, or one we can't parse (e.g. suffix ranges): serve the full file
            const fileBuffer = await fs.promises.readFile(resolved.path);
            return new Response(fileBuffer, {
                headers: {
                    "Content-Type": contentType,
                    "Content-Length": fileSize.toString(),
                    "Accept-Ranges": "bytes"
                }
            });
        } catch (error) {
            log.error("[API] original serve error:", error);
            return getPlaceholderResponse();
        }
    };
}
