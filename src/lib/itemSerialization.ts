/**
 * Normalization of `items` rows into the shape the client expects.
 *
 * Rules:
 *  - `tags` / `folders` are normalized independently to string arrays. Invalid
 *    JSON, non-array JSON and missing/NULL values yield []. Non-string elements
 *    are dropped (never coerced), so the client can always `.map()` them.
 *  - `palettes` is an array of `{ color: [r, g, b], ratio }` (finite numbers).
 *    Malformed entries are dropped; a malformed/non-array column yields [].
 *  - Authorization never relies on this normalization: with active locks the
 *    listing excludes items whose membership is malformed in SQL (see
 *    itemsHandler.ts) so a corrupt `folders` value is not "folderless".
 *  - Other columns pass through unchanged.
 */

export interface Palette {
    color: [number, number, number];
    ratio: number;
}

export interface SerializedItem {
    id: string;
    name: string;
    ext: string;
    tags: string[];
    folders: string[];
    palettes: Palette[];
    [key: string]: unknown;
}

function parseJson(raw: unknown): unknown {
    if (typeof raw !== 'string' || raw === '') return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

export function normalizeStringArray(raw: unknown): string[] {
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

export function normalizePalettes(raw: unknown): Palette[] {
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Palette[] = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        const { color, ratio } = entry as { color?: unknown; ratio?: unknown };
        if (!Array.isArray(color) || color.length !== 3 || !color.every(isFiniteNumber)) continue;
        if (!isFiniteNumber(ratio)) continue;
        out.push({ color: [color[0], color[1], color[2]], ratio });
    }
    return out;
}

export function serializeItem(row: Record<string, unknown>): SerializedItem {
    return {
        ...row,
        tags: normalizeStringArray(row.tags),
        folders: normalizeStringArray(row.folders),
        palettes: normalizePalettes(row.palettes)
    } as SerializedItem;
}
