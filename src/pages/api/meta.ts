import type { APIRoute } from 'astro';
import { folderCache, performLibraryScan, findFolderById, getAllSubFolderIds, type Folder } from '../../lib/db';
import { getUnlockedFolderIds } from '../../lib/unlock';

// Never send folder passwords to the client; expose only whether a password
// exists (hasPassword) and the user-facing hint (passwordTips)
function sanitizeFolders(folders: Folder[]): Record<string, unknown>[] {
    return folders.map(({ password, children, ...rest }) => ({
        ...rest,
        hasPassword: !!(password && password.length > 0),
        children: children ? sanitizeFolders(children) : []
    }));
}

export const GET: APIRoute = async ({ request }) => {
    if (folderCache.folders.length === 0) {
        await performLibraryScan();
    }

    // Folders this client already unlocked (valid session cookie), so the UI
    // stays unlocked across page reloads
    const unlockedIds = new Set<string>();
    getUnlockedFolderIds(request).forEach(id => {
        const folder = findFolderById(folderCache.folders, id);
        if (folder) getAllSubFolderIds(folder).forEach(sub => unlockedIds.add(sub));
    });

    return new Response(JSON.stringify({
        folders: sanitizeFolders(folderCache.folders),
        tags: folderCache.allTags,
        tagCounts: folderCache.tagCounts,
        tagsGroups: folderCache.tagsGroups,
        lockedFolderIds: Array.from(folderCache.lockedFolderIds),
        unlockedFolderIds: Array.from(unlockedIds)
    }), {
        headers: {
            "Content-Type": "application/json"
        }
    });
}
