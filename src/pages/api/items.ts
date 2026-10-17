import { db, folderCache, findFolderById, getAllSubFolderIds } from '../../lib/db';
import { createItemsHandler } from '../../lib/itemsHandler';
import { ensureLockState, getLockState } from '../../lib/mediaAccess';

export const GET = createItemsHandler({
    db,
    ensureLockState,
    getLockState,
    subtreeFolderIds: (folderId) => {
        const folder = findFolderById(folderCache.folders, folderId);
        return folder ? Array.from(getAllSubFolderIds(folder)) : null;
    }
});
