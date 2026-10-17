import { describe, expect, test } from 'bun:test';
import { contentRangeHeader, parseRange, unsatisfiableContentRange, type RangeDecision } from '../src/lib/httpRange';

const partial = (start: number, end: number): RangeDecision => ({ kind: 'partial', range: { start, end } });
const FULL: RangeDecision = { kind: 'full' };
const BAD: RangeDecision = { kind: 'unsatisfiable' };

describe('parseRange: valid forms (size 100)', () => {
    test('explicit', () => {
        expect(parseRange('bytes=0-99', 100)).toEqual(partial(0, 99));
        expect(parseRange('bytes=10-19', 100)).toEqual(partial(10, 19));
        expect(parseRange('bytes=0-0', 100)).toEqual(partial(0, 0));
        expect(parseRange('bytes=99-99', 100)).toEqual(partial(99, 99));
    });
    test('open-ended', () => {
        expect(parseRange('bytes=0-', 100)).toEqual(partial(0, 99));
        expect(parseRange('bytes=90-', 100)).toEqual(partial(90, 99));
        expect(parseRange('bytes=99-', 100)).toEqual(partial(99, 99));
    });
    test('suffix', () => {
        expect(parseRange('bytes=-1', 100)).toEqual(partial(99, 99));
        expect(parseRange('bytes=-50', 100)).toEqual(partial(50, 99));
        expect(parseRange('bytes=-100', 100)).toEqual(partial(0, 99));
    });
    test('end beyond size is clamped; suffix longer than file selects the whole file', () => {
        expect(parseRange('bytes=50-5000', 100)).toEqual(partial(50, 99));
        expect(parseRange('bytes=-5000', 100)).toEqual(partial(0, 99));
    });
    test('unit is case-insensitive and whitespace around is tolerated', () => {
        expect(parseRange('  Bytes=0-3 ', 100)).toEqual(partial(0, 3));
        expect(parseRange('BYTES = 0-3', 100)).toEqual(partial(0, 3));
    });
});

describe('parseRange: unsatisfiable', () => {
    test('start at or beyond size', () => {
        expect(parseRange('bytes=100-', 100)).toEqual(BAD);
        expect(parseRange('bytes=100-120', 100)).toEqual(BAD);
        expect(parseRange('bytes=999999999-', 100)).toEqual(BAD);
    });
    test('start > end', () => {
        expect(parseRange('bytes=10-5', 100)).toEqual(BAD);
    });
    test('zero-length suffix', () => {
        expect(parseRange('bytes=-0', 100)).toEqual(BAD);
    });
    test('every range on an empty file', () => {
        for (const h of ['bytes=0-0', 'bytes=0-', 'bytes=-1', 'bytes=-500', 'bytes=0-10']) {
            expect([h, parseRange(h, 0)]).toEqual([h, BAD]);
        }
    });
    test('1-byte file', () => {
        expect(parseRange('bytes=0-', 1)).toEqual(partial(0, 0));
        expect(parseRange('bytes=-5', 1)).toEqual(partial(0, 0));
        expect(parseRange('bytes=1-', 1)).toEqual(BAD);
    });
});

describe('parseRange: ignored (served as full 200)', () => {
    test('absent / non-string', () => {
        expect(parseRange(null, 100)).toEqual(FULL);
        expect(parseRange(undefined, 100)).toEqual(FULL);
        expect(parseRange('', 100)).toEqual(FULL);
    });
    test('malformed', () => {
        for (const h of ['bytes', 'bytes=', 'bytes=-', 'bytes=abc', 'bytes=1-2-3', 'bytes=a-b', 'bytes=1 - 2', 'bytes=+1-2', 'bytes=-1.5', '0-10', 'garbage']) {
            expect([h, parseRange(h, 100)]).toEqual([h, FULL]);
        }
    });
    test('unknown unit', () => {
        expect(parseRange('items=0-1', 100)).toEqual(FULL);
    });
    test('multiple ranges are ignored (policy: no multipart support)', () => {
        expect(parseRange('bytes=0-1,5-6', 100)).toEqual(FULL);
        expect(parseRange('bytes=0-1, -5', 100)).toEqual(FULL);
        expect(parseRange('bytes=500-600,700-800', 100)).toEqual(FULL);
    });
    test('invalid size is not trusted', () => {
        expect(parseRange('bytes=0-1', NaN)).toEqual(FULL);
        expect(parseRange('bytes=0-1', -1)).toEqual(FULL);
    });
});

describe('parseRange: huge numbers', () => {
    const huge = '9'.repeat(40);
    test('huge end is clamped, huge start unsatisfiable, huge suffix is whole file', () => {
        expect(parseRange(`bytes=5-${huge}`, 100)).toEqual(partial(5, 99));
        expect(parseRange(`bytes=${huge}-`, 100)).toEqual(BAD);
        expect(parseRange(`bytes=${huge}-${huge}`, 100)).toEqual(BAD);
        expect(parseRange(`bytes=-${huge}`, 100)).toEqual(partial(0, 99));
    });
    test('values at the safe-integer edge do not produce unsafe offsets', () => {
        const r = parseRange(`bytes=0-${Number.MAX_SAFE_INTEGER}`, 100);
        expect(r).toEqual(partial(0, 99));
        expect(parseRange(`bytes=${Number.MAX_SAFE_INTEGER + 2}-`, 100)).toEqual(BAD);
    });
    test('leading zeros parse as decimal', () => {
        expect(parseRange('bytes=007-010', 100)).toEqual(partial(7, 10));
    });
});

describe('header formatting', () => {
    test('Content-Range shapes', () => {
        expect(contentRangeHeader({ start: 0, end: 99 }, 1000)).toBe('bytes 0-99/1000');
        expect(unsatisfiableContentRange(1000)).toBe('bytes */1000');
        expect(unsatisfiableContentRange(0)).toBe('bytes */0');
    });
});
