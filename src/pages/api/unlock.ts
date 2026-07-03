import type { APIRoute } from 'astro';
import { folderCache, findFolderById, getAllSubFolderIds } from '../../lib/db';
import { safeEquals, unlockCookie } from '../../lib/unlock';

export const POST: APIRoute = async ({ request }) => {
    let folderId: unknown, password: unknown;
    try {
        ({ folderId, password } = await request.json());
    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid request' }), { status: 400 });
    }

    if (typeof folderId !== 'string' || typeof password !== 'string' || !password) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid request' }), { status: 400 });
    }

    const folder = findFolderById(folderCache.folders, folderId);
    if (!folder || !folder.password) {
        return new Response(JSON.stringify({ success: false, error: 'Folder not found' }), { status: 404 });
    }

    // Eagle stores folder passwords Base64-encoded in metadata.json; also
    // accept a plaintext match in case other versions store it raw
    const decoded = Buffer.from(folder.password, 'base64').toString('utf8');
    if (!safeEquals(decoded, password) && !safeEquals(folder.password, password)) {
        return new Response(JSON.stringify({ success: false, error: 'Incorrect password' }), { status: 401 });
    }

    // Unlocking a folder unlocks its whole subtree
    const unlockedIds = Array.from(getAllSubFolderIds(folder));

    return new Response(JSON.stringify({ success: true, unlockedIds }), {
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': unlockCookie(folderId)
        }
    });
};
