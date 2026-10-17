/**
 * Bounded parsing of client-controlled query parameters for /api/items.
 * Malformed input never throws: it degrades to the default or is clamped.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const DEFAULT_PAGE = 1;
/** Keeps (page - 1) * limit far inside the safe-integer range. */
export const MAX_PAGE = 1_000_000;
export const DEFAULT_COLOR_ACCURACY = 60;
export const MAX_COLOR_ACCURACY = 150;

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Numeric value of a plain decimal/exponent string; null for anything else (hex, "abc", "", null...). */
function parseNumeric(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    const trimmed = raw.trim();
    if (!NUMERIC.test(trimmed)) return null;
    return Number(trimmed);
}

/**
 * Integer in [min, max]. Non-numeric, non-integer (floats) and values below
 * `min` (0, negatives) use `fallback`; values above `max` (including
 * Infinity and unsafe magnitudes) clamp to `max`.
 */
export function parseBoundedInt(raw: string | null | undefined, opts: { min: number; max: number; fallback: number }): number {
    const n = parseNumeric(raw);
    if (n === null || Number.isNaN(n)) return opts.fallback;
    if (n === Infinity) return opts.max;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < opts.min) return opts.fallback;
    return Math.min(n, opts.max);
}

export function parseLimit(raw: string | null | undefined): number {
    return parseBoundedInt(raw, { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
}

export function parsePage(raw: string | null | undefined): number {
    return parseBoundedInt(raw, { min: 1, max: MAX_PAGE, fallback: DEFAULT_PAGE });
}

/**
 * Color tolerance in [0, 150]; zero is preserved (exact match). Garbage uses
 * the default, fractions truncate, out-of-range values clamp.
 */
export function parseColorAccuracy(raw: string | null | undefined): number {
    const n = parseNumeric(raw);
    if (n === null || Number.isNaN(n)) return DEFAULT_COLOR_ACCURACY;
    if (n === Infinity) return MAX_COLOR_ACCURACY;
    if (n === -Infinity) return 0;
    return Math.min(MAX_COLOR_ACCURACY, Math.max(0, Math.trunc(n)));
}

/** Zero-based row offset; null if it is not a safe non-negative integer (callers must not query). */
export function computeOffset(page: number, limit: number): number | null {
    const offset = (page - 1) * limit;
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}
