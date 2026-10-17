import { describe, expect, test } from 'bun:test';
import { downloadLinkProps, openOriginalLinkProps, originalUrl } from '../src/lib/mediaUrls';
import { decodeReservedEscapes, parseOriginalPath } from '../src/lib/originalPath';
import { astroParams, roundTrip } from './helpers/astroRouting';

const NAMES = [
    'plain', 'with space', 'фото', '日本語', '50%', 'a%20b', '100%25', '%41', 'hash#tag', 'q?x', 'a&b=c', 'a+b', 'semi;colon',
    'at@sign', 'dollar$', 'comma,x', 'colon:x', 'eq=x', 'quote"x', "apos'x", 'a%2Fb', 'emoji😀', 'trail.', 'dots..',
];

describe('originalUrl', () => {
    test('basic shape keeps the epoch', () => {
        expect(originalUrl('ABC', 'photo', 'png')).toBe('/images/ABC.info/photo.png?v=2');
    });

    test('encodes each segment once (no double encoding)', () => {
        expect(originalUrl('ABC', 'a b', 'png')).toBe('/images/ABC.info/a%20b.png?v=2');
        expect(originalUrl('ABC', 'a#b?c&d+e', 'png')).toBe('/images/ABC.info/a%23b%3Fc%26d%2Be.png?v=2');
        expect(originalUrl('ABC', 'фото', 'png')).toBe('/images/ABC.info/%D1%84%D0%BE%D1%82%D0%BE.png?v=2');
        expect(originalUrl('ABC', '日本語', 'jpg')).toContain('%E6%97%A5%E6%9C%AC%E8%AA%9E.jpg');
        expect(originalUrl('ABC', '50%', 'png')).toBe('/images/ABC.info/50%25.png?v=2');
    });

    test('literal %XX names use the n query carrier (router rejects %25XX paths)', () => {
        const url = originalUrl('ABC', 'a%20b', 'png');
        expect(url).toBe('/images/ABC.info/original.png?v=2&n=a%2520b.png');
        expect(url.split('?')[0]).not.toMatch(/%25[0-9a-f]{2}/i);
    });

    test('names with separators carry the explicit recover=1 signal (placeholder path, no n)', () => {
        expect(originalUrl('ABC', 'a/b', 'png')).toBe('/images/ABC.info/original.png?v=2&recover=1');
        expect(originalUrl('ABC', 'a\\b', 'png')).toBe('/images/ABC.info/original.png?v=2&recover=1');
    });

    test('separator + literal %XX follows the recovery path, never n=', () => {
        const url = originalUrl('ABC', 'a/b%20c', 'png', undefined, { download: true });
        expect(url).toBe('/images/ABC.info/original.png?v=2&recover=1&download=1');
        expect(url).not.toContain('n=');
    });

    test('addressable names never carry recover=1', () => {
        for (const name of NAMES) expect(originalUrl('ID1', name, 'png')).not.toContain('recover=');
    });

    test('download flag adds download=1 after the epoch', () => {
        expect(originalUrl('ABC', 'p', 'png', undefined, { download: true })).toBe('/images/ABC.info/p.png?v=2&download=1');
    });

    test('every awkward name round-trips to exactly itself through router + route decoding', () => {
        for (const name of NAMES) {
            const parsed = roundTrip(originalUrl('ID1', name, 'png'));
            expect(parsed).toEqual({ ok: true, itemId: 'ID1', fileName: `${name}.png` });
        }
    });

    test('names unaddressable by path do not decode to a different real name', () => {
        const parsed = roundTrip(originalUrl('ID1', 'a/b', 'png'));
        expect(parsed).toEqual({ ok: true, itemId: 'ID1', fileName: 'original.png' });
    });
});

describe('router simulation fidelity (real Astro validateAndDecodePathname)', () => {
    test('rejects %25+hex before decoding', () => {
        expect(astroParams('/images/x.info/50%2541.png')).toBe('ROUTER_400');
    });

    test('rejects %25+hex produced BY decoding (post-decode multi-level check)', () => {
        // %25 then escaped "2541" (no literal %25+hex in the source) decodes to "%2541"
        expect(astroParams('/images/x.info/%25%32%35%34%31.png')).toBe('ROUTER_400');
    });

    test('malformed escape falls back to the raw path; normal escapes decode once', () => {
        expect(astroParams('/images/x.info/%E0%A4%A.png')).toBe('x.info/%E0%A4%A.png');
        expect(astroParams('/images/x.info/a%20b%23.png')).toBe('x.info/a b%23.png');
    });
});

describe('link props', () => {
    test('open original: new tab with noopener', () => {
        const p = openOriginalLinkProps('ID1', 'x y', 'png');
        expect(p.target).toBe('_blank');
        expect(p.rel.split(' ')).toContain('noopener');
        expect(p.href).toBe('/images/ID1.info/x%20y.png?v=2');
    });

    test('download: attachment URL and exact (Unicode) download attribute', () => {
        const p = downloadLinkProps('ID1', 'фото', 'png');
        expect(p.href).toContain('download=1');
        expect(p.download).toBe('фото.png');
    });
});

describe('route-side decoding', () => {
    test('decodeReservedEscapes decodes only what decodeURI leaves behind', () => {
        expect(decodeReservedEscapes('a%23b%3Fc%2Bd%2fe')).toBe('a#b?c+d/e');
        expect(decodeReservedEscapes('plain')).toBe('plain');
        expect(decodeReservedEscapes('50%')).toBe('50%');
        expect(decodeReservedEscapes('a%20b')).toBeNull();
        expect(decodeReservedEscapes('%C3%A9')).toBeNull();
    });

    test('shape errors', () => {
        expect(parseOriginalPath('x.info')).toEqual({ ok: false, status: 404 });
        expect(parseOriginalPath('x/y.png')).toEqual({ ok: false, status: 404 });
        expect(parseOriginalPath('x.info/a/b')).toEqual({ ok: false, status: 404 });
        expect(parseOriginalPath('x.info/%E0%A4%A')).toEqual({ ok: false, status: 400 });
        expect(parseOriginalPath('x.info/a%20b')).toEqual({ ok: false, status: 400 });
    });

    test('n override replaces the path segment', () => {
        expect(parseOriginalPath('x.info/original.png', 'a%20b.png')).toEqual({ ok: true, itemId: 'x', fileName: 'a%20b.png' });
    });
});
