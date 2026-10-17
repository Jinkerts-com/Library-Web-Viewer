import { describe, expect, test } from 'bun:test';
import {
    SHAPE_KEYS, asciiLower, classifyShapes, cycleInclude, facetState, parseCustomRatio, parseFacetQuery,
    parseRatioComponent, toggleExclude, typeLabel, type FacetSelection, type ShapeKey,
} from '../src/lib/itemFacets';

const shapes = (w: unknown, h: unknown, custom = { width: 4, height: 3 }) => classifyShapes(w, h, custom);
const has = (w: unknown, h: unknown, key: ShapeKey, custom?: { width: number; height: number }) => shapes(w, h, custom).includes(key);

describe('shape classification', () => {
    test('overlapping predicates: a 4:3 image is also Horizontal; a panorama is also Horizontal', () => {
        expect(shapes(400, 300)).toEqual(['horizontal', '4:3', 'custom']);
        expect(shapes(3000, 1000)).toEqual(['horizontal', 'panoramic-horizontal']);
        expect(shapes(1000, 3000)).toEqual(['vertical', 'panoramic-vertical']);
        expect(shapes(1920, 1080)).toEqual(['horizontal', '16:9']);
        expect(shapes(1080, 1920)).toEqual(['vertical', '9:16']);
        expect(shapes(300, 400)).toEqual(['vertical', '3:4']);
    });

    test('horizontal / vertical / square thresholds', () => {
        expect(has(101, 100, 'horizontal')).toBe(true);
        expect(has(100, 100, 'horizontal')).toBe(false);
        expect(has(100, 101, 'vertical')).toBe(true);
        expect(has(100, 100, 'vertical')).toBe(false);
        expect(has(100, 100, 'square')).toBe(true);
        expect(has(100, 101, 'square')).toBe(false); // exact: no tolerance for square
        expect(has(1000, 999, 'square')).toBe(false);
    });

    test('panoramic thresholds are inclusive at exactly 2:1 and 1:2', () => {
        expect(has(200, 100, 'panoramic-horizontal')).toBe(true);
        expect(has(199, 100, 'panoramic-horizontal')).toBe(false);
        expect(has(100, 200, 'panoramic-vertical')).toBe(true);
        expect(has(100, 199, 'panoramic-vertical')).toBe(false);
        expect(has(200, 100, 'horizontal')).toBe(true);
    });

    test('named ratios: inclusive ±2% band, exact edges', () => {
        // 4:3 at height 100: 130.718 <= w <= 136.0 (upper edge 136 is exactly inclusive)
        expect(has(136, 100, '4:3')).toBe(true);
        expect(has(137, 100, '4:3')).toBe(false);
        expect(has(131, 100, '4:3')).toBe(true);
        expect(has(130, 100, '4:3')).toBe(false);
        // 16:9 at height 900: 16/9*900 = 1600; band 1568.627..1632
        expect(has(1632, 900, '16:9')).toBe(true);
        expect(has(1633, 900, '16:9')).toBe(false);
        expect(has(1569, 900, '16:9')).toBe(true);
        expect(has(1568, 900, '16:9')).toBe(false);
        // 9:16 and 3:4 are the reciprocal orientations
        expect(has(900, 1600, '9:16')).toBe(true);
        expect(has(900, 1600, '16:9')).toBe(false);
        expect(has(300, 400, '3:4')).toBe(true);
        expect(has(300, 400, '4:3')).toBe(false);
        expect(has(100, 136, '3:4')).toBe(true); // 100/136 is exactly 0.75/1.02 (inclusive lower edge)
        expect(has(100, 137, '3:4')).toBe(false);
    });

    test('custom ratio uses the committed pair with the same band; reciprocal is a different target', () => {
        const c21 = { width: 21, height: 9 };
        expect(has(2100, 900, 'custom', c21)).toBe(true);
        expect(has(900, 2100, 'custom', c21)).toBe(false);
        expect(has(400, 300, 'custom', c21)).toBe(false);
        expect(has(100, 100, 'custom', { width: 1, height: 1 })).toBe(true);
        expect(has(102, 100, 'custom', { width: 1, height: 1 })).toBe(true);
        expect(has(103, 100, 'custom', { width: 1, height: 1 })).toBe(false);
        expect(has(100, 102, 'custom', { width: 1, height: 1 })).toBe(true);
        expect(has(100, 103, 'custom', { width: 1, height: 1 })).toBe(false);
    });

    test('zero, negative, null, undefined and malformed dimensions match no shape at all', () => {
        const bad: [unknown, unknown][] = [
            [0, 0], [0, 10], [10, 0], [-10, -10], [-10, 10], [10, -10], [null, 10], [10, null], [null, null],
            [undefined, undefined], ['10', '10'], ['abc', 10], [NaN, 10], [10, Infinity], [Infinity, Infinity], [{}, []],
        ];
        for (const [w, h] of bad) expect(shapes(w, h)).toEqual([]);
    });

    test('every key is classified for some input (fixed key list is complete)', () => {
        const seen = new Set<string>();
        for (const [w, h] of [[400, 300], [300, 400], [1920, 1080], [1080, 1920], [100, 100], [300, 100], [100, 300], [5, 3]] as const) {
            shapes(w, h).forEach(k => seen.add(k));
        }
        for (const key of SHAPE_KEYS) expect(seen.has(key)).toBe(true);
    });
});

describe('custom ratio validation', () => {
    test('accepts decimal positive integers 1..10000', () => {
        for (const v of ['1', '4', '10000', '9999', '007']) expect(parseRatioComponent(v).ok).toBe(true);
        expect(parseRatioComponent('007')).toEqual({ ok: true, value: 7 });
    });

    test('rejects empty, zero, over-range, decimals, signs, exponents, hex, whitespace and junk', () => {
        for (const v of ['', '0', '10001', '99999', '100000', '1.5', '4.0', '.5', '+4', '-4', '1e3', '0x10', ' 4', '4 ', '4a', 'abc', '١٢', '4,3', '00000'] as string[]) {
            expect(parseRatioComponent(v).ok).toBe(false);
        }
        expect(parseRatioComponent(null).ok).toBe(false);
        expect(parseRatioComponent(undefined).ok).toBe(false);
    });

    test('a pair commits both values or neither, reporting which side is bad', () => {
        expect(parseCustomRatio('21', '9')).toEqual({ ok: true, value: { width: 21, height: 9 } });
        const half = parseCustomRatio('21', 'x');
        expect(half.ok).toBe(false);
        if (!half.ok) { expect(half.widthError).toBeNull(); expect(half.heightError).not.toBeNull(); }
        const both = parseCustomRatio('', '0');
        expect(both.ok).toBe(false);
        if (!both.ok) { expect(both.widthError).not.toBeNull(); expect(both.heightError).not.toBeNull(); }
    });
});

describe('facet query parsing', () => {
    const q = (s: string) => parseFacetQuery(new URLSearchParams(s));

    test('no params -> empty selections with the default 4:3 custom pair', () => {
        expect(q('')).toEqual({ ok: true, value: { includedShapes: [], excludedShapes: [], customRatio: { width: 4, height: 3 }, includedTypes: [], excludedTypes: [] } });
    });

    test('repeated params, dedupe, ASCII lowercase types, reserved empty type key', () => {
        const r = q('shape=horizontal&shape=4%3A3&shape=horizontal&excludedShape=panoramic-horizontal&type=PNG&type=png&type=jpg&excludedType=&ratioWidth=21&ratioHeight=9');
        expect(r).toEqual({ ok: true, value: {
            includedShapes: ['horizontal', '4:3'], excludedShapes: ['panoramic-horizontal'], customRatio: { width: 21, height: 9 },
            includedTypes: ['png', 'jpg'], excludedTypes: [''],
        } });
    });

    test('malformed new params are rejected, never silently broadened', () => {
        for (const s of [
            'shape=banana', 'shape=', 'excludedShape=Horizontal', 'shape=horizontal,vertical',
            'ratioWidth=4', 'ratioHeight=3', 'ratioWidth=0&ratioHeight=3', 'ratioWidth=4&ratioHeight=1.5',
            'ratioWidth=4&ratioWidth=5&ratioHeight=3', 'ratioWidth=10001&ratioHeight=3', 'ratioWidth=&ratioHeight=',
            `type=${'x'.repeat(33)}`, `excludedType=${'y'.repeat(100)}`,
            Array.from({ length: 65 }, (_, i) => `type=t${i}`).join('&'),
            Array.from({ length: 33 }, () => 'shape=square').join('&'),
        ]) expect(q(s).ok).toBe(false);
    });

    test('injection-shaped type keys parse as inert data', () => {
        const r = q(`type=${encodeURIComponent("png' OR 1=1 --")}`);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.includedTypes).toEqual(["png' or 1=1 --"]);
    });

    test('asciiLower only touches ASCII; labels', () => {
        expect(asciiLower('PnG')).toBe('png');
        expect(asciiLower('É')).toBe('É');
        expect(typeLabel('png')).toBe('PNG');
        expect(typeLabel('')).toBe('No extension');
    });
});

describe('include/exclude transitions', () => {
    const empty: FacetSelection = { included: [], excluded: [] };

    test('row click: neutral -> included -> neutral; excluded -> neutral', () => {
        const inc = cycleInclude(empty, 'a');
        expect(inc).toEqual({ included: ['a'], excluded: [] });
        expect(cycleInclude(inc, 'a')).toEqual(empty);
        expect(cycleInclude<string>({ included: [], excluded: ['a'] }, 'a')).toEqual(empty);
    });

    test('exclude control: neutral/included -> excluded (atomically leaving included); excluded -> neutral', () => {
        expect(toggleExclude(empty, 'a')).toEqual({ included: [], excluded: ['a'] });
        expect(toggleExclude({ included: ['a', 'b'], excluded: [] }, 'a')).toEqual({ included: ['b'], excluded: ['a'] });
        expect(toggleExclude<string>({ included: [], excluded: ['a'] }, 'a')).toEqual(empty);
    });

    test('a key is never in both lists after any transition (no contradictory intermediate state)', () => {
        let s: FacetSelection = empty;
        const steps = [cycleInclude, toggleExclude, cycleInclude, toggleExclude, toggleExclude, cycleInclude];
        for (const step of steps) {
            s = step(s, 'a');
            expect(s.included.includes('a') && s.excluded.includes('a')).toBe(false);
        }
    });

    test('transitions are pure and leave other keys alone', () => {
        const before: FacetSelection = { included: ['a'], excluded: ['b'] };
        const after = cycleInclude(before, 'c');
        expect(before).toEqual({ included: ['a'], excluded: ['b'] });
        expect(after).toEqual({ included: ['a', 'c'], excluded: ['b'] });
        expect(facetState(after, 'b')).toBe('excluded');
        expect(facetState(after, 'a')).toBe('included');
        expect(facetState(after, 'z')).toBe('neutral');
    });
});
