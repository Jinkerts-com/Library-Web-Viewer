import { db, folderCache, libraryPath, performLibraryScan } from './db';
import { createLockInitializer, lockStateFromCache } from './lockSnapshot';
import { parseFolderMembership, type AccessDeps, type AccessItem, type LockState } from './itemAccess';

/** Production wiring of itemAccess: live folder cache + SQLite lookup. */

export function getLockState(): LockState {
    return lockStateFromCache(folderCache);
}

export function lookupItem(id: string): AccessItem | null {
    const row = db.query("SELECT id, name, ext, folders FROM items WHERE id = ?").get(id) as
        { id: string; name: string; ext: string; folders: string | null } | null;
    if (!row) return null;
    const folders = parseFolderMembership(row.folders);
    if (!folders) return null; // unparsable membership: fail closed
    return { id: row.id, name: row.name, ext: row.ext, folders };
}

export const productionAccessDeps: AccessDeps = { getLockState, lookupItem };

/**
 * Makes one best-effort attempt to load lock metadata (via a scan, as /api/meta
 * does) when it is not ready. Overlapping requests coalesce into one attempt,
 * but SEQUENTIAL requests while still unready retry at most once per
 * LOCK_RETRY_INTERVAL_MS (a failed attempt is not repeated on every request).
 * Once lock metadata has loaded (even a legitimately folderless library) no
 * further attempt is made. Callers must still check readiness afterwards: a
 * failed or busy attempt leaves it unready and protected content denied.
 */
export const LOCK_RETRY_INTERVAL_MS = 3000;

export const ensureLockState = createLockInitializer(
    () => folderCache.lastUpdated > 0,
    () => performLibraryScan(),
    () => !!libraryPath,
    { retryIntervalMs: LOCK_RETRY_INTERVAL_MS }
);
