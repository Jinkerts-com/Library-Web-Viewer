/**
 * Shape (aspect ratio) and type (file extension) filter vocabulary shared by the
 * API handler and the UI. Pure and client-safe: no server, SQL or store imports.
 *
 * Shape matching contract (APPLICATION rules, not a claim of Eagle parity).
 * Predicates OVERLAP: a 4:3 image is also Horizontal, a panorama is also
 * Horizontal. Only items whose width AND height are finite numbers > 0 classify;
 * anything else matches no shape at all (not even Square). With r = width / height:
 *
 *   horizontal            r > 1
 *   vertical              r < 1
 *   square                width = height (exact)
 *   panoramic-horizontal  r >= 2
 *   panoramic-vertical    r <= 0.5
 *   4:3 / 3:4 / 16:9 / 9:16 / custom
 *                         target/1.02 <= r <= target*1.02 (inclusive ±2% band)
 *
 * The comparisons are evaluated by cross-multiplication (no division), so the
 * SQL and this module agree exactly and integer division can never bite.
 */

export const SHAPE_KEYS = [
    'horizontal', 'vertical', 'square', 'panoramic-horizontal', 'panoramic-vertical',
    '4:3', '3:4', '16:9', '9:16', 'custom',
] as const;
export type ShapeKey = typeof SHAPE_KEYS[number];

export const SHAPE_LABELS: Record<ShapeKey, string> = {
    'horizontal': 'Horizontal',
    'vertical': 'Vertical',
    'square': 'Square',
    'panoramic-horizontal': 'Panoramic Horizontal',
    'panoramic-vertical': 'Panoramic Vertical',
    '4:3': '4:3',
    '3:4': '3:4',
    '16:9': '16:9',
    '9:16': '9:16',
    'custom': 'Custom',
};

export const SHAPE_KEY_SET: ReadonlySet<string> = new Set(SHAPE_KEYS);
export const isShapeKey = (v: unknown): v is ShapeKey => typeof v === 'string' && SHAPE_KEY_SET.has(v);

export interface CustomRatio { width: number; height: number }
export const DEFAULT_CUSTOM_RATIO: CustomRatio = { width: 4, height: 3 };
export const MAX_RATIO_VALUE = 10_000;

/** Named ratio targets as [width, height]. */
export const NAMED_RATIOS = {
    '4:3': [4, 3], '3:4': [3, 4], '16:9': [16, 9], '9:16': [9, 16],
} as const;

/** Tolerance band is expressed as integers (102/100 = ×1.02) so edges are exact. */
export const TOLERANCE_NUM = 102;
export const TOLERANCE_DEN = 100;

export const MAX_SHAPE_PARAMS = 32;
export const MAX_TYPE_PARAMS = 64;
export const MAX_TYPE_KEY_LENGTH = 32;
/** Largest typeCounts map the client accepts. */
export const MAX_TYPE_FACETS = 1000;

/** ASCII-only lowercase: identical to SQLite's LOWER(), so keys round-trip. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));

export const NO_EXTENSION_KEY = '';
export const typeLabel = (key: string): string => key === NO_EXTENSION_KEY ? 'No extension' : key.toUpperCase();

/** Positive, finite width and height; the only items that can match a shape. */
export function hasValidDimensions(width: unknown, height: unknown): boolean {
    return typeof width === 'number' && typeof height === 'number'
        && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function withinBand(w: number, h: number, tw: number, th: number): boolean {
    return w * th * TOLERANCE_NUM >= tw * h * TOLERANCE_DEN && w * th * TOLERANCE_DEN <= tw * h * TOLERANCE_NUM;
}

/** Reference classifier (mirrors the SQL predicates): every shape key the item matches. */
export function classifyShapes(width: unknown, height: unknown, custom: CustomRatio = DEFAULT_CUSTOM_RATIO): ShapeKey[] {
    if (!hasValidDimensions(width, height)) return [];
    const w = width as number;
    const h = height as number;
    const out: ShapeKey[] = [];
    if (w > h) out.push('horizontal');
    if (w < h) out.push('vertical');
    if (w === h) out.push('square');
    if (w >= 2 * h) out.push('panoramic-horizontal');
    if (2 * w <= h) out.push('panoramic-vertical');
    for (const key of ['4:3', '3:4', '16:9', '9:16'] as const) {
        if (withinBand(w, h, NAMED_RATIOS[key][0], NAMED_RATIOS[key][1])) out.push(key);
    }
    if (withinBand(w, h, custom.width, custom.height)) out.push('custom');
    return out;
}

// ---------------------------------------------------------------- custom ratio

const RATIO_DIGITS = /^[0-9]{1,5}$/;

export type RatioParse = { ok: true; value: number } | { ok: false; error: string };

/** One custom-ratio component: decimal positive integer 1-10,000 (no signs, decimals, exponents, blanks). */
export function parseRatioComponent(raw: string | null | undefined): RatioParse {
    if (raw === null || raw === undefined || raw === '') return { ok: false, error: 'Enter a whole number' };
    if (!RATIO_DIGITS.test(raw)) return { ok: false, error: 'Use digits only' };
    const n = Number(raw);
    if (n < 1 || n > MAX_RATIO_VALUE) return { ok: false, error: `Use 1 to ${MAX_RATIO_VALUE.toLocaleString('en-US')}` };
    return { ok: true, value: n };
}

export type RatioPairParse =
    | { ok: true; value: CustomRatio }
    | { ok: false; widthError: string | null; heightError: string | null };

/** Both components must be valid; the pair is committed atomically or not at all. */
export function parseCustomRatio(width: string | null | undefined, height: string | null | undefined): RatioPairParse {
    const w = parseRatioComponent(width);
    const h = parseRatioComponent(height);
    if (w.ok && h.ok) return { ok: true, value: { width: w.value, height: h.value } };
    return { ok: false, widthError: w.ok ? null : w.error, heightError: h.ok ? null : h.error };
}

// ------------------------------------------------------------------ query parse

export interface FacetQuery {
    includedShapes: ShapeKey[];
    excludedShapes: ShapeKey[];
    customRatio: CustomRatio;
    includedTypes: string[];
    excludedTypes: string[];
}

export type FacetQueryParse = { ok: true; value: FacetQuery } | { ok: false };

function readShapes(raw: string[]): ShapeKey[] | null {
    if (raw.length > MAX_SHAPE_PARAMS) return null;
    const out: ShapeKey[] = [];
    for (const v of raw) {
        if (!isShapeKey(v)) return null;
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

function readTypes(raw: string[]): string[] | null {
    if (raw.length > MAX_TYPE_PARAMS) return null;
    const out = new Set<string>();
    for (const v of raw) {
        if (v.length > MAX_TYPE_KEY_LENGTH) return null;
        out.add(asciiLower(v));
    }
    return [...out];
}

/** Parse the repeated shape/type params. Any malformed new param rejects the whole request (never silently broadened). */
export function parseFacetQuery(params: URLSearchParams): FacetQueryParse {
    const includedShapes = readShapes(params.getAll('shape'));
    const excludedShapes = readShapes(params.getAll('excludedShape'));
    const includedTypes = readTypes(params.getAll('type'));
    const excludedTypes = readTypes(params.getAll('excludedType'));
    if (!includedShapes || !excludedShapes || !includedTypes || !excludedTypes) return { ok: false };

    let customRatio = DEFAULT_CUSTOM_RATIO;
    const rw = params.getAll('ratioWidth');
    const rh = params.getAll('ratioHeight');
    if (rw.length || rh.length) {
        if (rw.length !== 1 || rh.length !== 1) return { ok: false };
        const parsed = parseCustomRatio(rw[0], rh[0]);
        if (!parsed.ok) return { ok: false };
        customRatio = parsed.value;
    }
    return { ok: true, value: { includedShapes, excludedShapes, customRatio, includedTypes, excludedTypes } };
}

// ------------------------------------------------------- include/exclude states

export interface FacetSelection<K extends string = string> {
    included: K[];
    excluded: K[];
}
export type FacetState = 'neutral' | 'included' | 'excluded';

export function facetState<K extends string>(sel: FacetSelection<K>, key: NoInfer<K>): FacetState {
    return sel.excluded.includes(key) ? 'excluded' : sel.included.includes(key) ? 'included' : 'neutral';
}

/** Row click: neutral -> included, included -> neutral, excluded -> neutral. */
export function cycleInclude<K extends string>(sel: FacetSelection<K>, key: NoInfer<K>): FacetSelection<K> {
    switch (facetState(sel, key)) {
        case 'neutral': return { included: [...sel.included, key], excluded: sel.excluded };
        case 'included': return { included: sel.included.filter(k => k !== key), excluded: sel.excluded };
        case 'excluded': return { included: sel.included, excluded: sel.excluded.filter(k => k !== key) };
    }
}

/** Exclude control: neutral/included -> excluded, excluded -> neutral. */
export function toggleExclude<K extends string>(sel: FacetSelection<K>, key: NoInfer<K>): FacetSelection<K> {
    if (facetState(sel, key) === 'excluded') return { included: sel.included, excluded: sel.excluded.filter(k => k !== key) };
    return { included: sel.included.filter(k => k !== key), excluded: [...sel.excluded, key] };
}

export const EMPTY_SELECTION: FacetSelection<never> = { included: [], excluded: [] };
