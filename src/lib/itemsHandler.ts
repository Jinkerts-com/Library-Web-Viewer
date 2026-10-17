import type { APIRoute } from 'astro';
import { lockedFolderIdsForRequest, type LockState } from './itemAccess';
import { serializeItem } from './itemSerialization';
import { computeOffset, parseColorAccuracy, parseLimit, parsePage } from './requestParams';
import { nonThrowingLogger } from './scan';

/**
 * GET /api/items as a factory over injected dependencies (database, lock
 * state, folder tree), so the listing is testable against a temp database.
 *
 * Malformed JSON columns (SQL side): every json_each() input goes through
 * `safeArray()`, which yields NULL (no rows) unless the column is a valid JSON
 * array, so corrupt rows can never raise "malformed JSON" in filters, counts
 * or the contextual tag query.
 *
 * Fail-closed membership: when this request has any effective locked folder,
 * rows whose `folders` is not NULL/'' or a valid array of strings are excluded
 * from the list, the count and the contextual tags (never treated as
 * folderless). Only when no lock applies does malformed membership degrade to
 * "no folders" (folder-less in All / uncategorized, bad elements dropped).
 */

export interface ItemsHandlerDeps {
    db: { query(sql: string): { get(...p: any[]): unknown; all(...p: any[]): unknown[] } };
    ensureLockState: () => Promise<void>;
    getLockState: () => LockState;
    /** Folder ids in the subtree rooted at `folderId` (inclusive), or null if the folder does not exist. */
    subtreeFolderIds: (folderId: string) => string[] | null;
    log?: { error: (...args: any[]) => void };
}

export const GENERIC_ERROR_MESSAGE = "Internal server error";

const JSON_HEADERS = { "Content-Type": "application/json" };

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

function safeArray(column: string): string {
    return `CASE WHEN json_valid(${column}) THEN (CASE WHEN json_type(${column}) = 'array' THEN ${column} END) END`;
}

const SAFE_FOLDERS = safeArray('items.folders');
const SAFE_TAGS = safeArray('items.tags');
const SAFE_PALETTES = safeArray('items.palettes');

/** Membership is well-formed: NULL/'' (folderless) or a JSON array containing only strings. */
const MEMBERSHIP_OK = `(items.folders IS NULL OR items.folders = '' OR (${SAFE_FOLDERS} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(${SAFE_FOLDERS}) WHERE type <> 'text')))`;

function hexToRgb(hex: string): [number, number, number] | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : null;
}

const sortExpressions: Record<string, string> = {
    modificationTime: "modificationTime",
    btime: "COALESCE(btime, modificationTime)",
    name: "name COLLATE NOCASE",
    ext: "ext COLLATE NOCASE",
    size: "size",
    dimensions: "(width * height)",
    star: "COALESCE(star, 0)",
    duration: "COALESCE(duration, 0)"
};

export function createItemsHandler(deps: ItemsHandlerDeps): APIRoute {
    const log = nonThrowingLogger(deps.log ?? console);

    return async ({ request }) => {
        try {
            const url = new URL(request.url);
            const search = url.searchParams.get('search');
            const tag = url.searchParams.get('tag');
            const folderId = url.searchParams.get('folderId');
            const page = parsePage(url.searchParams.get('page'));
            const limit = parseLimit(url.searchParams.get('limit'));
            const sortBy = url.searchParams.get('sortBy') || 'modificationTime';
            const sortOrder = url.searchParams.get('sortOrder') || 'desc';
            const excludedTagsStr = url.searchParams.get('excludedTags');
            const specialFilter = url.searchParams.get('specialFilter');
            const colorHex = url.searchParams.get('color');
            const colorAccuracy = parseColorAccuracy(url.searchParams.get('colorAccuracy'));
            const targetRgb = colorHex ? hexToRgb(colorHex) : null;

            const offset = computeOffset(page, limit);
            if (offset === null) return json({ error: "Invalid pagination" }, 400);

            let whereClause = " WHERE 1=1";
            const params: (string | number)[] = [];

            // Trash: deleted items are only visible in the dedicated trash view
            whereClause += specialFilter === 'trash'
                ? ` AND COALESCE(isDeleted, 0) = 1`
                : ` AND COALESCE(isDeleted, 0) = 0`;

            // Locked folders: hide their contents everywhere (search, All, tags,
            // trash...) unless this client unlocked them (verified session cookie);
            // unlocking a folder uncovers its whole subtree
            // Fail closed: until lock metadata has loaded, nothing can be listed
            await deps.ensureLockState();
            const effectiveLockedIds = lockedFolderIdsForRequest(deps.getLockState(), request);
            if (!effectiveLockedIds) {
                return json({ error: "Library is not ready" }, 503);
            }
            const lockedIds = Array.from(effectiveLockedIds);
            if (lockedIds.length) {
                const placeholders = lockedIds.map(() => '?').join(', ');
                whereClause += ` AND ${MEMBERSHIP_OK} AND NOT EXISTS (SELECT 1 FROM json_each(${SAFE_FOLDERS}) WHERE value IN (${placeholders}))`;
                params.push(...lockedIds);
            }

            // Special Filters Logic
            if (specialFilter === 'uncategorized') {
                whereClause += ` AND NOT EXISTS (SELECT 1 FROM json_each(${SAFE_FOLDERS}) WHERE type = 'text')`;
            } else if (specialFilter === 'untagged') {
                whereClause += ` AND NOT EXISTS (SELECT 1 FROM json_each(${SAFE_TAGS}) WHERE type = 'text')`;
            }

            // Filter by Folder
            if (folderId) {
                if (effectiveLockedIds.has(folderId)) {
                    return json({ items: [], totalItems: 0, relevantTags: [] });
                }

                if (url.searchParams.get('recursive') === 'true') {
                    const ids = deps.subtreeFolderIds(folderId);
                    if (ids) {
                        if (ids.length) {
                            const placeholders = ids.map(() => '?').join(', ');
                            whereClause += ` AND EXISTS (SELECT 1 FROM json_each(${SAFE_FOLDERS}) WHERE value IN (${placeholders}))`;
                            params.push(...ids);
                        }
                    } else {
                        // Folder not found
                        whereClause += ` AND 1=0`;
                    }
                } else {
                    // Flat - Only this folder
                    whereClause += ` AND EXISTS (SELECT 1 FROM json_each(${SAFE_FOLDERS}) WHERE value = ?)`;
                    params.push(folderId);
                }
            }

            // Snapshot of the view context (trash/locked/special/folder) before the
            // narrowing filters below — the contextual tag list is built from this so
            // it reflects the folder being viewed, not the current tag/search/color
            // selections
            const contextClause = whereClause;
            const contextParams = [...params];

            // Filter by Tag: "all" requires every selected tag, "any" matches items
            // with at least one of them
            if (tag) {
                const tags = tag.split(',');
                const exists = `EXISTS (SELECT 1 FROM json_each(${SAFE_TAGS}) WHERE value = ?)`;
                if (url.searchParams.get('tagRule') === 'any') {
                    whereClause += ` AND (${tags.map(() => exists).join(' OR ')})`;
                    params.push(...tags);
                } else {
                    tags.forEach(t => {
                        whereClause += ` AND ${exists}`;
                        params.push(t);
                    });
                }
            }

            // Filter by Excluded Tags
            if (excludedTagsStr) {
                excludedTagsStr.split(',').forEach(t => {
                    whereClause += ` AND NOT EXISTS (SELECT 1 FROM json_each(${SAFE_TAGS}) WHERE value = ?)`;
                    params.push(t);
                });
            }

            // Filter by Search
            if (search) {
                const term = `%${search}%`;
                whereClause += ` AND (name LIKE ? OR tags LIKE ? OR description LIKE ?)`;
                params.push(term, term, term);
            }

            // Filter by Color (squared distance to any palette color, computed in SQL
            // so pagination stays in the database). Inclusive (<=) so tolerance 0 is an
            // exact match; only well-formed numeric [r,g,b] entries can match.
            if (targetRgb) {
                const [r, g, b] = targetRgb;
                const num = (i: number) => `json_type(p.value, '$.color[${i}]') IN ('integer', 'real')`;
                const diff = (i: number) => `(json_extract(p.value, '$.color[${i}]') - ?) * (json_extract(p.value, '$.color[${i}]') - ?)`;
                whereClause += ` AND EXISTS (
                    SELECT 1 FROM json_each(${SAFE_PALETTES}) AS p
                    WHERE CASE WHEN p.type = 'object'
                        THEN CASE WHEN json_type(p.value, '$.color') = 'array' AND json_array_length(p.value, '$.color') = 3
                            AND ${num(0)} AND ${num(1)} AND ${num(2)}
                            THEN ${diff(0)} + ${diff(1)} + ${diff(2)} <= ?
                            ELSE 0 END
                        ELSE 0 END
                )`;
                params.push(r, r, g, g, b, b, colorAccuracy * colorAccuracy);
            }

            // Sort (keys map to fixed SQL expressions; never interpolate user input)
            const sortExpr = sortExpressions[sortBy] ?? sortExpressions.modificationTime;
            const safeOrder = sortOrder === "asc" ? "ASC" : "DESC";

            // Secondary key keeps ties in a stable order; the unique id last makes
            // pages deterministic (no duplicate/skipped rows). Random stays random.
            const orderClause = specialFilter === 'random'
                ? ` ORDER BY RANDOM()`
                : ` ORDER BY ${sortExpr} ${safeOrder}, modificationTime DESC, items.id ASC`;

            const countRow = deps.db.query(`SELECT COUNT(*) as count FROM items ${whereClause}`).get(...params) as { count: number } | undefined;
            const totalItems = countRow?.count || 0;

            const rows = deps.db
                .query(`SELECT * FROM items ${whereClause} ${orderClause} LIMIT ? OFFSET ?`)
                .all(...params, limit, offset) as Record<string, unknown>[];
            const items = rows.map(serializeItem);

            // Contextual Tags (with per-context usage counts)
            let relevantTags: string[] | undefined;
            let relevantTagCounts: Record<string, number> | undefined;
            if (page === 1) {
                try {
                    const tagRows = deps.db
                        .query(`SELECT je.value as tag, COUNT(*) as count FROM items, json_each(${SAFE_TAGS}) AS je ${contextClause} AND je.type = 'text' GROUP BY je.value`)
                        .all(...contextParams) as { tag: string; count: number }[];
                    relevantTags = tagRows.map(r => r.tag).sort();
                    relevantTagCounts = Object.fromEntries(tagRows.map(r => [r.tag, r.count]));
                } catch (e) {
                    // Never fall back to the global tag cache: it is not bound to the
                    // protected context (locks, folder, trash). Keep the item response.
                    log.error("[API] /items contextual tags error:", e);
                    relevantTags = [];
                    relevantTagCounts = {};
                }
            }

            return json({ items, totalItems, relevantTags, relevantTagCounts });
        } catch (err) {
            log.error("[API] /items Error:", err);
            return json({ error: GENERIC_ERROR_MESSAGE }, 500);
        }
    };
}
