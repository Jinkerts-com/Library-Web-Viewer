import { describe, expect, test } from 'bun:test';
import { attachmentDisposition, sanitizeDownloadName } from '../src/lib/contentDisposition';

describe('attachmentDisposition', () => {
    test('plain ASCII name', () => {
        expect(attachmentDisposition('photo.png')).toBe(`attachment; filename="photo.png"; filename*=UTF-8''photo.png`);
    });

    test('CR/LF can never reach the header value', () => {
        const v = attachmentDisposition('a\r\nSet-Cookie: x=1\r\n.png');
        expect(v).not.toMatch(/[\r\n]/);
        expect(v).toContain('a__Set-Cookie: x=1__.png');
        // and the value is accepted by the Headers API (would throw on CR/LF/NUL)
        expect(() => new Headers({ 'Content-Disposition': v })).not.toThrow();
    });

    test('quotes, backslashes, semicolons and percent are neutralised in the quoted-string', () => {
        const v = attachmentDisposition('a"b\\c;d%e.png');
        const quoted = v.match(/filename="([^"]*)"/)![1];
        expect(quoted).toBe('a_b_c_d_e.png');
        expect(v).toContain(`filename*=UTF-8''a%22b_c%3Bd%25e.png`);
    });

    test('Unicode: ASCII fallback plus RFC 8187 form', () => {
        const v = attachmentDisposition('фото 日本.png');
        expect(v).toContain(`filename="____ __.png"`);
        expect(v).toContain(`filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE%20%E6%97%A5%E6%9C%AC.png`);
        expect(() => new Headers({ 'Content-Disposition': v })).not.toThrow();
    });

    test("RFC 8187 attr-char: ' ( ) * are percent-encoded", () => {
        expect(attachmentDisposition("a'(b)*.png")).toContain(`filename*=UTF-8''a%27%28b%29%2A.png`);
    });

    test('lone surrogates do not throw', () => {
        expect(() => attachmentDisposition('bad\uD800name.png')).not.toThrow();
        expect(attachmentDisposition('bad\uD800name.png')).toContain('%EF%BF%BD');
    });

    test('empty, dot, dotdot and separator-only names fall back to a safe name', () => {
        for (const n of ['', '.', '..', '   ', '///', '\\', '\r\n', null, undefined, 42]) {
            expect(attachmentDisposition(n)).toBe(`attachment; filename="download"; filename*=UTF-8''download`);
        }
    });

    test('path separators are replaced', () => {
        expect(sanitizeDownloadName('../../etc/passwd')).toBe('.._.._etc_passwd');
    });

    test('bidi overrides are replaced', () => {
        expect(sanitizeDownloadName('a‮exe.png')).toBe('a_exe.png');
    });

    test('long names are truncated but keep the extension', () => {
        const s = sanitizeDownloadName('x'.repeat(1000) + '.png');
        expect(Array.from(s).length).toBeLessThanOrEqual(150);
        expect(s.endsWith('.png')).toBe(true);
        const u = sanitizeDownloadName('日'.repeat(1000));
        expect(Array.from(u).length).toBe(150);
    });
});
