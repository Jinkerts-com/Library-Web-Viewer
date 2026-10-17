/**
 * Safe `Content-Disposition: attachment` construction. Pure; never throws.
 *
 * Filenames come from the library's directory entries, i.e. attacker-influenced,
 * so they can never be interpolated into a header unescaped:
 *  - control characters (CR/LF in particular: header injection), bidi overrides and
 *    path separators are replaced, never passed through;
 *  - the quoted-string `filename` parameter is an ASCII-only fallback with `"` and `\`
 *    replaced (not backslash-escaped, which some user agents mishandle);
 *  - the real, possibly Unicode name travels in RFC 8187 `filename*=UTF-8''...`.
 */

const MAX_NAME_CHARS = 150;
const FALLBACK_NAME = 'download';

// Lone surrogates make encodeURIComponent throw
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// C0/C1 controls, DEL, line/paragraph separators, bidi embedding/override/isolate marks
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const SEPARATORS = /[\/\\]/g;

/** Display-safe name: no controls/separators, bounded length (keeps the extension). Never empty. */
export function sanitizeDownloadName(name: unknown): string {
    let s = typeof name === 'string' ? name : '';
    s = s.replace(LONE_SURROGATE, '\uFFFD').replace(UNSAFE_CHARS, '_').replace(SEPARATORS, '_').trim();
    const chars = Array.from(s);
    if (chars.length > MAX_NAME_CHARS) {
        const dot = s.lastIndexOf('.');
        const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
        s = chars.slice(0, MAX_NAME_CHARS - Array.from(ext).length).join('') + ext;
    }
    if (s === '' || s === '.' || s === '..' || /^_+$/.test(s)) return FALLBACK_NAME;
    return s;
}

/** ASCII fallback for the quoted-string parameter. */
function asciiFallback(safe: string): string {
    const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_').trim();
    return ascii === '' || /^[_.]+$/.test(ascii) ? FALLBACK_NAME : ascii;
}

/** RFC 8187 value-chars: attr-char only, everything else percent-encoded. */
function encodeRfc8187(value: string): string {
    return encodeURIComponent(value).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<utf8>` for any input string. */
export function attachmentDisposition(name: unknown): string {
    const safe = sanitizeDownloadName(name);
    const ascii = asciiFallback(safe);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc8187(safe)}`;
}
