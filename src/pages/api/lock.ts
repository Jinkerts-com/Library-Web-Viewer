import type { APIRoute } from 'astro';
import { folderCache, findFolderById, getAllSubFolderIds } from '../../lib/db';
import { createLockHandler } from '../../lib/unlockHandlers';
import { lockGuard } from '../../lib/requestGuards';

export const POST: APIRoute = createLockHandler({
    guard: lockGuard,
    findFolder: (id) => findFolderById(folderCache.folders, id),
    subtreeIds: getAllSubFolderIds
});
