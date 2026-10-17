import type { APIRoute } from 'astro';
import { folderCache, findFolderById, getAllSubFolderIds } from '../../lib/db';
import { createUnlockHandler } from '../../lib/unlockHandlers';
import { unlockGuard } from '../../lib/requestGuards';

// Same-origin (403) and per-client rate limit (429 + Retry-After) are enforced by
// unlockGuard before the password is looked at; see lib/requestSecurity.ts.
export const POST: APIRoute = createUnlockHandler({
    guard: unlockGuard,
    findFolder: (id) => findFolderById(folderCache.folders, id),
    subtreeIds: getAllSubFolderIds
});
