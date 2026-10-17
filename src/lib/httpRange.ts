/**
 * Single byte-range parsing (RFC 9110 14.1-14.4). Pure: no filesystem or
 * Request access, so it is testable on plain strings and sizes.
 *
 * Policy:
 *  - Range is a hint. Missing, non-"bytes" unit, malformed, or multi-range
 *    (comma-separated) headers are IGNORED -> the caller serves the full 200.
 *    Multipart/byteranges is intentionally unsupported; ignoring is permitted
 *    by RFC 9110 and gives such clients the complete representation.
 *  - A syntactically valid single range that cannot be satisfied is
 *    'unsatisfiable' (416 + `Content-Range: bytes STAR/size`): first >= size,
 *    last < first, a zero-length suffix, or any range on an empty file.
 *  - last beyond the end is clamped; a suffix longer than the file selects the
 *    whole file (still a 206 covering 0..size-1).
 *  - Numbers beyond Number.MAX_SAFE_INTEGER are treated as "infinitely large".
 */

export interface ByteRange {
    /** Inclusive offsets. */
    start: number;
    end: number;
}

export type RangeDecision =
    | { kind: 'full' }
    | { kind: 'partial'; range: ByteRange }
    | { kind: 'unsatisfiable' };

const BYTE_RANGE_SPEC = /^(\d*)-(\d*)$/;

function toSafe(digits: string): number {
    const n = Number(digits);
    return Number.isSafeInteger(n) ? n : Infinity;
}

export function parseRange(header: string | null | undefined, size: number): RangeDecision {
    if (typeof header !== 'string') return { kind: 'full' };

    const text = header.trim();
    const eq = text.indexOf('=');
    if (eq < 0 || text.slice(0, eq).trim().toLowerCase() !== 'bytes') return { kind: 'full' };

    const set = text.slice(eq + 1).trim();
    if (set.includes(',')) return { kind: 'full' };

    const match = BYTE_RANGE_SPEC.exec(set);
    if (!match || (match[1] === '' && match[2] === '')) return { kind: 'full' };

    if (!Number.isSafeInteger(size) || size < 0) return { kind: 'full' };

    if (match[1] === '') {
        // suffix-byte-range-spec: the last N bytes
        const suffix = toSafe(match[2]);
        if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
        return { kind: 'partial', range: { start: suffix >= size ? 0 : size - suffix, end: size - 1 } };
    }

    const start = toSafe(match[1]);
    const last = match[2] === '' ? Infinity : toSafe(match[2]);
    if (last < start || start >= size) return { kind: 'unsatisfiable' };
    return { kind: 'partial', range: { start, end: Math.min(last, size - 1) } };
}

export function contentRangeHeader(range: ByteRange, size: number): string {
    return `bytes ${range.start}-${range.end}/${size}`;
}

export function unsatisfiableContentRange(size: number): string {
    return `bytes */${size}`;
}
