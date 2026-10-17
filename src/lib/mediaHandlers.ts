import fs from 'fs';
import path from 'path';
import type { APIRoute } from 'astro';
import { authorizeItem, type AccessDecision, type AccessDeps } from './itemAccess';
import { resolveOriginal } from './mediaPaths';
import { getPlaceholderResponse } from './placeholder';
import { Readable } from 'stream';
import { getMimeType, isActiveContentType, safetyHeaders } from './mime';
import { attachmentDisposition } from './contentDisposition';
import { parseOriginalPath } from './originalPath';
import { contentRangeHeader, parseRange, unsatisfiableContentRange } from './httpRange';
import { nonThrowingLogger } from './scan';
import { contentEtag, fileEtag, isNotModified, notModifiedResponse, validatorHeaders } from './mediaCache';

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
    deps: MediaHandlerDeps & {
        generateThumbnail: (id: string) => Promise<Buffer | null>;
        /** Cache file mtime (epoch ms) for Last-Modified, when known. */
        lastModified?: (id: string) => number | null;
    }
): APIRoute {
    const log = nonThrowingLogger(deps.log ?? console);
    return async ({ params, request }) => {
        const decision = await authorize(deps, request, params.id);
        if (!decision.ok) return denied(decision);

        try {
            const buffer = await deps.generateThumbnail(decision.item.id);
            if (!buffer) return getPlaceholderResponse();
            const validators = { etag: contentEtag(buffer), lastModifiedMs: deps.lastModified?.(decision.item.id) ?? null };
            if (isNotModified(request, validators)) return notModifiedResponse(validators);
            return new Response(buffer as unknown as BodyInit, {
                headers: { "Content-Type": "image/webp", ...validatorHeaders(validators) }
            });
        } catch (error) {
            log.error("[API] thumbnail error:", error);
            return getPlaceholderResponse();
        }
    };
}

export function createPreviewHandler(
    deps: MediaHandlerDeps & {
        generatePreview: (id: string, ext: string) => Promise<Buffer | null>;
        /** Cache file mtime (epoch ms) for Last-Modified, when known. */
        lastModified?: (id: string) => number | null;
    }
): APIRoute {
    const log = nonThrowingLogger(deps.log ?? console);
    return async ({ params, request }) => {
        const decision = await authorize(deps, request, params.id);
        if (!decision.ok) return denied(decision);

        try {
            const buffer = await deps.generatePreview(decision.item.id, decision.item.ext);
            if (!buffer) return new Response("Preview unavailable", { status: 404 });
            const validators = { etag: contentEtag(buffer), lastModifiedMs: deps.lastModified?.(decision.item.id) ?? null };
            if (isNotModified(request, validators)) return notModifiedResponse(validators);
            return new Response(new Uint8Array(buffer), {
                status: 200,
                headers: { 'Content-Type': 'image/webp', ...validatorHeaders(validators) }
            });
        } catch (error) {
            log.error("[API] preview error:", error);
            return new Response("Internal Server Error", { status: 500 });
        }
    };
}

export function createOriginalHandler(
    deps: MediaHandlerDeps & {
        getLibraryPath: () => string;
        /** File-open seam (defaults to fs.promises.open); lets tests observe handle lifecycle. */
        openFile?: (file: string, flags: 'r') => Promise<fs.promises.FileHandle>;
    }
): APIRoute {
    const log = nonThrowingLogger(deps.log ?? console);
    const openFile = deps.openFile ?? ((file: string, flags: 'r') => fs.promises.open(file, flags));
    return async ({ params, request }) => {
        const libraryPath = deps.getLibraryPath();
        if (!libraryPath || !params.path) return getPlaceholderResponse();

        // Astro has already applied decodeURI once; the remainder (reserved escapes) is
        // decoded here, exactly once in total (see originalPath.ts). Names that cannot
        // travel in a path (literal "%XX") arrive in the `n` query parameter instead.
        let nameOverride: string | null = null;
        let download = false;
        let recoveryOnly = false;
        try {
            const query = new URL(request.url).searchParams;
            nameOverride = query.get('n');
            download = query.get('download') === '1';
            recoveryOnly = query.get('recover') === '1';
        } catch { /* unparsable URL: path-only */ }

        const parsed = parseOriginalPath(params.path, nameOverride);
        if (!parsed.ok) {
            return new Response(parsed.status === 400 ? "Invalid path" : "Not found", { status: parsed.status });
        }

        const decision = await authorize(deps, request, parsed.itemId);
        if (!decision.ok) return denied(decision);

        const resolved = resolveOriginal(libraryPath, decision.item.id, decision.item.ext, parsed.fileName, { recoveryOnly });
        if (resolved.kind === 'ambiguous') return new Response("Ambiguous original", { status: 409 });
        if (resolved.kind !== 'ok') return new Response("Not found", { status: 404 });

        try {
            const stat = fs.statSync(resolved.path);
            const fileSize = stat.size;
            const contentType = getMimeType(path.extname(resolved.path));
            const validators = { etag: fileEtag(stat.size, stat.mtimeMs), lastModifiedMs: stat.mtimeMs };
            const cacheHeaders = validatorHeaders(validators);

            // Conditional evaluation precedes Range handling (RFC 9110 13.2.2)
            if (isNotModified(request, validators)) return notModifiedResponse(validators);

            const baseHeaders: Record<string, string> = {
                ...cacheHeaders,
                ...safetyHeaders(contentType),
                "Content-Type": contentType,
                "Accept-Ranges": "bytes"
            };
            // Explicit downloads, and active formats always, are attachments (never an
            // inline same-origin document). <img>/<video> embedding is unaffected.
            if (download || isActiveContentType(contentType)) {
                baseHeaders["Content-Disposition"] = attachmentDisposition(path.basename(resolved.path));
            }

            // Range is only defined for GET (RFC 9110 14.2): HEAD (and anything else) gets
            // the full-response decision. Malformed/multi-range headers also fall through to 200.
            const decision = request.method === 'GET'
                ? parseRange(request.headers.get('range'), fileSize)
                : ({ kind: 'full' } as const);
            if (decision.kind === 'unsatisfiable') {
                return new Response(null, {
                    status: 416,
                    headers: { ...baseHeaders, "Content-Range": unsatisfiableContentRange(fileSize) }
                });
            }

            const range = decision.kind === 'partial' ? decision.range : null;
            const length = range ? range.end - range.start + 1 : fileSize;
            const headers: Record<string, string> = { ...baseHeaders, "Content-Length": length.toString() };
            if (range) headers["Content-Range"] = contentRangeHeader(range, fileSize);
            const status = range ? 206 : 200;

            if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers });

            // Open before responding so a vanished file is caught here (placeholder),
            // and stream only the needed slice instead of buffering the file.
            const handle = await openFile(resolved.path, 'r');
            let body: ReadableStream;
            try {
                const stream = handle.createReadStream(range ? { start: range.start, end: range.end } : {});
                body = Readable.toWeb(stream) as unknown as ReadableStream;
            } catch (error) {
                await handle.close().catch(() => { });
                throw error;
            }
            return new Response(body, { status, headers });
        } catch (error) {
            log.error("[API] original serve error:", error);
            return getPlaceholderResponse();
        }
    };
}
