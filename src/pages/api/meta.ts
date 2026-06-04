import type { APIRoute } from 'astro';
import { folderCache, performLibraryScan } from '../../lib/db';

export const GET: APIRoute = async ({ request }) => {
    if (folderCache.folders.length === 0) {
        await performLibraryScan();
    }

    return new Response(JSON.stringify({
        folders: folderCache.folders,
        tags: folderCache.allTags,
        tagsGroups: folderCache.tagsGroups,
        lockedFolderIds: Array.from(folderCache.lockedFolderIds)
    }), {
        headers: {
            "Content-Type": "application/json"
        }
    });
}
