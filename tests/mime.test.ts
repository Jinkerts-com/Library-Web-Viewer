import { describe, expect, test } from 'bun:test';
import { AUDIO_PLAY_EXTS, FALLBACK_MIME_TYPE, IMAGE_RENDER_EXTS, VIDEO_PLAY_EXTS, getMimeType, safetyHeaders } from '../src/lib/mime';

const table: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/vnd.microsoft.icon', '.tif': 'image/tiff',
    '.tiff': 'image/tiff', '.psd': 'image/vnd.adobe.photoshop', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
    '.pdf': 'application/pdf',
};

describe('getMimeType', () => {
    for (const [ext, mime] of Object.entries(table)) {
        test(`${ext} -> ${mime}`, () => expect(getMimeType(ext)).toBe(mime));
    }
    test('every extension the modal renders or plays is mapped', () => {
        for (const ext of [...IMAGE_RENDER_EXTS, ...VIDEO_PLAY_EXTS, ...AUDIO_PLAY_EXTS]) {
            expect(getMimeType(`.${ext}`)).not.toBe(FALLBACK_MIME_TYPE);
        }
    });
    test('case-insensitive', () => {
        expect(getMimeType('.JPG')).toBe('image/jpeg');
        expect(getMimeType('.SVG')).toBe('image/svg+xml');
        expect(getMimeType('.Flac')).toBe('audio/flac');
    });
    test('unknown, empty and prototype-ish keys fall back to octet-stream', () => {
        for (const ext of ['.xyz', '', '.', 'png', 'constructor', '__proto__', 'toString', '.html']) {
            expect(getMimeType(ext)).toBe('application/octet-stream');
        }
    });
});

describe('safetyHeaders', () => {
    test('everything is nosniff', () => {
        for (const mime of [...Object.values(table), FALLBACK_MIME_TYPE]) {
            expect(safetyHeaders(mime)['X-Content-Type-Options']).toBe('nosniff');
        }
    });
    test('SVG gets a sandboxing CSP with default-src none', () => {
        const csp = safetyHeaders('image/svg+xml')['Content-Security-Policy'];
        expect(csp).toContain("default-src 'none'");
        expect(csp).toMatch(/(^|; )sandbox($|;)/);
        expect(csp).not.toContain('allow-scripts');
        expect(csp).not.toContain('script-src');
    });
    test('media and raster images carry no CSP', () => {
        for (const mime of ['image/png', 'video/mp4', 'audio/ogg', 'application/pdf']) {
            expect(safetyHeaders(mime)['Content-Security-Policy']).toBeUndefined();
        }
    });
});
