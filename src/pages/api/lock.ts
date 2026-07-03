import type { APIRoute } from 'astro';
import { folderCache, findFolderById, getAllSubFolderIds } from '../../lib/db';
import { expireUnlockCookie } from '../../lib/unlock';

export const POST: APIRoute = async ({ request }) => {
    let folderId: unknown;
    try {
        ({ folderId } = await request.json());
    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid request' }), { status: 400 });
    }

    if (typeof folderId !== 'string') {
        return new Response(JSON.stringify({ success: false, error: 'Invalid request' }), { status: 400 });
    }

    const folder = findFolderById(folderCache.folders, folderId);
    if (!folder) {
        return new Response(JSON.stringify({ success: false, error: 'Folder not found' }), { status: 404 });
    }

    // Re-locking covers the same subtree the unlock uncovered
    const lockedIds = Array.from(getAllSubFolderIds(folder));

    return new Response(JSON.stringify({ success: true, lockedIds }), {
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': expireUnlockCookie(folderId)
        }
    });
};
