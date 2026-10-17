// Keyed by lower-case extension including the dot. A Map (not an object literal)
// so inherited keys such as "constructor" can never resolve to a value.
const mimeTypes = new Map<string, string>([
    // Images
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.avif', 'image/avif'],
    ['.bmp', 'image/bmp'],
    ['.ico', 'image/vnd.microsoft.icon'],
    ['.tif', 'image/tiff'],
    ['.tiff', 'image/tiff'],
    ['.psd', 'image/vnd.adobe.photoshop'],
    ['.svg', 'image/svg+xml'],
    // Video
    ['.mp4', 'video/mp4'],
    ['.webm', 'video/webm'],
    ['.mov', 'video/quicktime'],
    // Audio. ".ogg" is ambiguous (audio or video); the modal plays it as audio, so
    // audio/ogg is the default here.
    ['.mp3', 'audio/mpeg'],
    ['.wav', 'audio/wav'],
    ['.m4a', 'audio/mp4'],
    ['.ogg', 'audio/ogg'],
    ['.flac', 'audio/flac'],
    ['.aac', 'audio/aac'],
    // Documents
    ['.pdf', 'application/pdf'],
]);

export const FALLBACK_MIME_TYPE = 'application/octet-stream';

// Extensions (no dot, lower-case) the modal renders directly from the original or plays
// natively. Shared with the modal so the MIME table cannot silently drift from it.
export const IMAGE_RENDER_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'] as const;
export const VIDEO_PLAY_EXTS = ['mp4', 'webm', 'mov'] as const;
export const AUDIO_PLAY_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'] as const;

/** MIME type for an extension with its leading dot (as from path.extname); case-insensitive. */
export function getMimeType(ext: string): string {
    return mimeTypes.get(String(ext).toLowerCase()) ?? FALLBACK_MIME_TYPE;
}

/**
 * Types that can execute script or load subresources when navigated to
 * directly, so they must never run with the app's origin privileges.
 */
const ACTIVE_CONTENT_TYPES = new Set(['image/svg+xml']);

/**
 * Active formats are never navigated to inline on the app origin: they are always
 * served as attachments (see mediaHandlers), on top of the sandbox CSP below.
 * <img> use is unaffected by Content-Disposition.
 */
export function isActiveContentType(contentType: string): boolean {
    return ACTIVE_CONTENT_TYPES.has(contentType);
}

/**
 * Extra response headers that keep served originals from becoming same-origin
 * active documents:
 *  - nosniff on everything, so a mislabelled or unknown file is never sniffed into HTML;
 *  - SVG additionally gets a sandboxing CSP: `sandbox` gives the document an
 *    opaque origin without script, forms or popups, and `default-src 'none'`
 *    blocks all loads (inline styles stay allowed so a directly opened SVG renders).
 *    <img> usage is unaffected because images never execute script.
 * PDFs are served inline without CSP sandbox (it breaks the browsers' built-in
 * PDF viewers); the viewer is isolated from the page DOM by the browser.
 */
export function safetyHeaders(contentType: string): Record<string, string> {
    const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff' };
    if (ACTIVE_CONTENT_TYPES.has(contentType)) {
        headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }
    return headers;
}
