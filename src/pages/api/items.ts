
import { db, folderCache, findFolderById, getAllSubFolderIds } from '../../lib/db';

import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request }) => {
    const url = new URL(request.url);
    const search = url.searchParams.get('search');
    const tag = url.searchParams.get('tag');
    const folderId = url.searchParams.get('folderId');
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const sortBy = url.searchParams.get('sortBy') || 'modificationTime';
    const sortOrder = url.searchParams.get('sortOrder') || 'desc';
    const excludedTagsStr = url.searchParams.get('excludedTags');
    const specialFilter = url.searchParams.get('specialFilter');
    const colorHex = url.searchParams.get('color');
    const colorAccuracyStr = url.searchParams.get('colorAccuracy');
    const colorAccuracy = colorAccuracyStr ? parseInt(colorAccuracyStr) : 60;

    // Color match helpers
    function hexToRgb(hex: string) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : null;
    }

    function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) {
        return Math.sqrt(Math.pow(r2 - r1, 2) + Math.pow(g2 - g1, 2) + Math.pow(b2 - b1, 2));
    }

    const targetRgb = colorHex ? hexToRgb(colorHex) : null;

    let baseQuery = "SELECT * FROM items";
    let whereClause = " WHERE 1=1";
    const params: any[] = [];

    // Special Filters Logic
    if (specialFilter === 'uncategorized') {
        whereClause += ` AND (folders IS NULL OR folders = '[]')`;
    } else if (specialFilter === 'untagged') {
        whereClause += ` AND (tags IS NULL OR tags = '[]')`;
    }

    // Filter by Folder
    if (folderId) {
        if (folderCache.lockedFolderIds.has(folderId)) {
            return new Response(JSON.stringify({ items: [], totalItems: 0, relevantTags: [] }), { headers: { "Content-Type": "application/json" } });
        }

        const isRecursive = url.searchParams.get('recursive') === 'true';

        if (isRecursive) {
            const targetFolder = findFolderById(folderCache.folders, folderId);
            if (targetFolder) {
                const subIds = getAllSubFolderIds(targetFolder);
                const ids = Array.from(subIds);
                const folderClauses = ids.map(() => `folders LIKE ?`).join(" OR ");
                if (folderClauses) {
                    whereClause += ` AND (${folderClauses})`;
                    ids.forEach(id => params.push(`%${id}%`));
                }
            } else {
                // Folder not found
                whereClause += ` AND 1=0`;
            }
        } else {
            // Flat - Only this folder
            whereClause += ` AND folders LIKE ?`;
            params.push(`%${folderId}%`);
        }
    }

    // Filter by Tag
    if (tag) {
        const tags = tag.split(',');
        tags.forEach(t => {
            whereClause += ` AND EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value = ?)`;
            params.push(t);
        });
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

    // Sort
    const allowedSort = ["name", "size", "modificationTime"];
    let safeSort = allowedSort.includes(sortBy) ? sortBy : "modificationTime";
    const safeOrder = sortOrder === "asc" ? "ASC" : "DESC";

    if (specialFilter === 'random') {
        safeSort = "RANDOM()";
    }

    const orderClause = specialFilter === 'random' ? ` ORDER BY RANDOM()` : ` ORDER BY ${safeSort} ${safeOrder}`;

    // console.log(`[API] /items request. params:`, { page, limit, folderId, sortBy });

    // Execute Query
    // Execute Query (Synchronous)
    try {
        let totalItems = 0;
        let items: any[] = [];

        if (targetRgb) {
            // Memory filter for Colors
            const fullQuery = `${baseQuery} ${whereClause} ${orderClause}`;
            const allRows = db.query(fullQuery).all(...params) as any[];

            const filteredRows = allRows.filter(r => {
                try {
                    const palettes = JSON.parse(r.palettes || '[]');
                    for (const p of palettes) {
                        if (p.color && p.color.length === 3) {
                            const dist = colorDistance(targetRgb[0], targetRgb[1], targetRgb[2], p.color[0], p.color[1], p.color[2]);
                            if (dist < colorAccuracy) return true; // dynamic threshold
                        }
                    }
                    return false;
                } catch (e) {
                    return false;
                }
            });

            totalItems = filteredRows.length;
            const startIndex = (page - 1) * limit;
            const paginatedRows = filteredRows.slice(startIndex, startIndex + limit);

            items = paginatedRows.map(r => {
                try {
                    return { ...r, tags: JSON.parse(r.tags), folders: JSON.parse(r.folders), palettes: JSON.parse(r.palettes || '[]') };
                } catch (e) { return r; }
            });
        } else {
            // Standard SQLite Native Search
            const countQuery = `SELECT COUNT(*) as count FROM items ${whereClause}`;
            const countRow = db.query(countQuery).get(...params) as any;
            totalItems = countRow?.count || 0;

            const paginationParams = [...params, limit, (page - 1) * limit];
            const paginationQuery = `${baseQuery} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
            const rows = db.query(paginationQuery).all(...paginationParams) as any[];

            items = rows.map(r => {
                try {
                    return { ...r, tags: JSON.parse(r.tags), folders: JSON.parse(r.folders), palettes: JSON.parse(r.palettes || '[]') };
                } catch (e) { return r; }
            });
        }

        // Contextual Tags
        let relevantTags;
        if (page === 1) {
            const distinctTagQuery = `SELECT DISTINCT value as tag FROM items, json_each(items.tags) ${whereClause}`;
            try {
                const tagRows = db.query(distinctTagQuery).all(...params) as any[];
                relevantTags = tagRows.map(r => r.tag).sort();
            } catch (e) {
                relevantTags = folderCache.allTags;
            }
        }

        return new Response(JSON.stringify({
            items,
            totalItems,
            relevantTags
        }), { headers: { "Content-Type": "application/json" } });

    } catch (err: any) {
        console.error("[API] /items Error:", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
}
