import type { APIRoute } from 'astro';
import { folderCache, findFolderById, getAllSubFolderIds } from '../../lib/db';
import { ensureLockState } from '../../lib/mediaAccess';
import { createMetaHandler } from '../../lib/metaHandler';

export const GET: APIRoute = createMetaHandler({
    ensureLockState,
    getCache: () => folderCache,
    findFolder: (id) => findFolderById(folderCache.folders, id),
    subtreeIds: getAllSubFolderIds
});
