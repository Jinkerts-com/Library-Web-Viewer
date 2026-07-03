
import { db, folderCache, findFolderById, getAllSubFolderIds } from '../../lib/db';
import { getUnlockedFolderIds } from '../../lib/unlock';

import type { APIRoute } from 'astro';

interface ItemRow {
    id: string;
    name: string;
    ext: string;
    tags: string;
    folders: string;
    palettes: string | null;
    [key: string]: unknown;
}

export const GET: APIRoute = async ({ request }) => {
    const url = new URL(request.url);
    const search = url.searchParams.get('search');
    const tag = url.searchParams.get('tag');
    const folderId = url.searchParams.get('folderId');
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1') || 1);
    const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '50') || 50);
    const sortBy = url.searchParams.get('sortBy') || 'modificationTime';
    const sortOrder = url.searchParams.get('sortOrder') || 'desc';
    const excludedTagsStr = url.searchParams.get('excludedTags');
    const specialFilter = url.searchParams.get('specialFilter');
    const colorHex = url.searchParams.get('color');
    const colorAccuracyStr = url.searchParams.get('colorAccuracy');
    const colorAccuracy = colorAccuracyStr ? parseInt(colorAccuracyStr) || 60 : 60;

    function hexToRgb(hex: string) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : null;
    }

    const targetRgb = colorHex ? hexToRgb(colorHex) : null;

    let baseQuery = "SELECT * FROM items";
    let whereClause = " WHERE 1=1";
    const params: (string | number)[] = [];

    // Trash: deleted items are only visible in the dedicated trash view
    if (specialFilter === 'trash') {
        whereClause += ` AND COALESCE(isDeleted, 0) = 1`;
    } else {
        whereClause += ` AND COALESCE(isDeleted, 0) = 0`;
    }

    // Locked folders: hide their contents everywhere (search, All, tags,
    // trash...) unless this client unlocked them (verified session cookie);
    // unlocking a folder uncovers its whole subtree
    const effectiveLockedIds = new Set(folderCache.lockedFolderIds);
    getUnlockedFolderIds(request).forEach(id => {
        const unlockedFolder = findFolderById(folderCache.folders, id);
        if (unlockedFolder) getAllSubFolderIds(unlockedFolder).forEach(sub => effectiveLockedIds.delete(sub));
    });
    const lockedIds = Array.from(effectiveLockedIds);
    if (lockedIds.length) {
        const placeholders = lockedIds.map(() => '?').join(', ');
        whereClause += ` AND NOT EXISTS (SELECT 1 FROM json_each(items.folders) WHERE value IN (${placeholders}))`;
        params.push(...lockedIds);
    }

    // Special Filters Logic
    if (specialFilter === 'uncategorized') {
        whereClause += ` AND (folders IS NULL OR folders = '[]')`;
    } else if (specialFilter === 'untagged') {
        whereClause += ` AND (tags IS NULL OR tags = '[]')`;
    }

    // Filter by Folder
    if (folderId) {
        if (effectiveLockedIds.has(folderId)) {
            return new Response(JSON.stringify({ items: [], totalItems: 0, relevantTags: [] }), { headers: { "Content-Type": "application/json" } });
        }

        const isRecursive = url.searchParams.get('recursive') === 'true';

        if (isRecursive) {
            const targetFolder = findFolderById(folderCache.folders, folderId);
            if (targetFolder) {
                const subIds = getAllSubFolderIds(targetFolder);
                const ids = Array.from(subIds);
                if (ids.length) {
                    const placeholders = ids.map(() => '?').join(', ');
                    whereClause += ` AND EXISTS (SELECT 1 FROM json_each(items.folders) WHERE value IN (${placeholders}))`;
                    params.push(...ids);
                }
            } else {
                // Folder not found
                whereClause += ` AND 1=0`;
            }
        } else {
            // Flat - Only this folder
            whereClause += ` AND EXISTS (SELECT 1 FROM json_each(items.folders) WHERE value = ?)`;
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
        if (url.searchParams.get('tagRule') === 'any') {
            const clause = tags.map(() => `EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value = ?)`).join(' OR ');
            whereClause += ` AND (${clause})`;
            params.push(...tags);
        } else {
            tags.forEach(t => {
                whereClause += ` AND EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value = ?)`;
                params.push(t);
            });
        }
    }

    // Filter by Excluded Tags
    if (excludedTagsStr) {
        const excluded = excludedTagsStr.split(',');
        excluded.forEach(t => {
            whereClause += ` AND NOT EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value = ?)`;
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
    // so pagination stays in the database)
    if (targetRgb) {
        const [r, g, b] = targetRgb;
        whereClause += ` AND items.palettes IS NOT NULL AND json_valid(items.palettes) AND EXISTS (
            SELECT 1 FROM json_each(items.palettes)
            WHERE (json_extract(value, '$.color[0]') - ?) * (json_extract(value, '$.color[0]') - ?)
                + (json_extract(value, '$.color[1]') - ?) * (json_extract(value, '$.color[1]') - ?)
                + (json_extract(value, '$.color[2]') - ?) * (json_extract(value, '$.color[2]') - ?)
                < ?
        )`;
        params.push(r, r, g, g, b, b, colorAccuracy * colorAccuracy);
    }

    // Sort (keys map to fixed SQL expressions; never interpolate user input)
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
    const sortExpr = sortExpressions[sortBy] ?? sortExpressions.modificationTime;
    const safeOrder = sortOrder === "asc" ? "ASC" : "DESC";

    // Secondary key keeps ties (same rating, no duration, etc.) in a stable order
    const orderClause = specialFilter === 'random' ? ` ORDER BY RANDOM()` : ` ORDER BY ${sortExpr} ${safeOrder}, modificationTime DESC`;

    const parseRow = (r: ItemRow) => {
        try {
            return { ...r, tags: JSON.parse(r.tags), folders: JSON.parse(r.folders), palettes: JSON.parse(r.palettes || '[]') };
        } catch (e) { return r; }
    };

    // Execute Query (Synchronous)
    try {
        const countQuery = `SELECT COUNT(*) as count FROM items ${whereClause}`;
        const countRow = db.query(countQuery).get(...params) as { count: number } | undefined;
        const totalItems = countRow?.count || 0;

        const paginationParams = [...params, limit, (page - 1) * limit];
        const paginationQuery = `${baseQuery} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
        const rows = db.query(paginationQuery).all(...paginationParams) as ItemRow[];

        const items = rows.map(parseRow);

        // Contextual Tags (with per-context usage counts)
        let relevantTags;
        let relevantTagCounts: Record<string, number> | undefined;
        if (page === 1) {
            const distinctTagQuery = `SELECT value as tag, COUNT(*) as count FROM items, json_each(items.tags) ${contextClause} GROUP BY value`;
            try {
                const tagRows = db.query(distinctTagQuery).all(...contextParams) as { tag: string; count: number }[];
                relevantTags = tagRows.map(r => r.tag).sort();
                relevantTagCounts = Object.fromEntries(tagRows.map(r => [r.tag, r.count]));
            } catch (e) {
                relevantTags = folderCache.allTags;
            }
        }

        return new Response(JSON.stringify({
            items,
            totalItems,
            relevantTags,
            relevantTagCounts
        }), { headers: { "Content-Type": "application/json" } });

    } catch (err) {
        console.error("[API] /items Error:", err);
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), { status: 500 });
    }
}
