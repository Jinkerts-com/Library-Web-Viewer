import type { LockState } from './itemAccess';

/**
 * Validated, atomically published folder/lock snapshots. Pure (no import-time
 * side effects): `db.ts` feeds its `folderCache` through `publishLockSnapshot`
 * and `mediaAccess.ts` reads it through `lockStateFromCache`, so tests exercise
 * the same code with a plain object.
 *
 * Invariant: missing/corrupt root metadata must never become "ready, nothing
 * locked". An invalid document is rejected whole; the previous snapshot (or the
 * unready initial state) stays in force.
 */

/** The slice of `FolderCache` that carries authorization state. */
export interface LockSnapshotTarget {
    folders: any[];
    tagsGroups: any[];
    lockedFolderIds: Set<string>;
    /** 0 = never loaded successfully (unready). */
    lastUpdated: number;
}

export type SnapshotResult = { ok: true } | { ok: false; reason: string };

function validateFolders(list: unknown, where: string): string | null {
    if (!Array.isArray(list)) return `${where} is not an array`;
    for (let i = 0; i < list.length; i++) {
        const node = list[i];
        const at = `${where}[${i}]`;
        if (node === null || typeof node !== 'object' || Array.isArray(node)) return `${at} is not an object`;
        const f = node as Record<string, unknown>;
        if (typeof f.id !== 'string' || f.id.length === 0) return `${at} has no usable id`;
        // password drives the lock decision: only absent/null/string are meaningful
        if (f.password !== undefined && f.password !== null && typeof f.password !== 'string') return `${at}.password is not a string`;
        if (f.children !== undefined && f.children !== null) {
            const err = validateFolders(f.children, `${at}.children`);
            if (err) return err;
        }
    }
    return null;
}

function collectLocked(folders: any[]): Set<string> {
    const locked = new Set<string>();
    const walk = (list: any[], parentLocked: boolean) => {
        for (const folder of list) {
            const isLocked = parentLocked || (typeof folder.password === 'string' && folder.password.length > 0);
            if (isLocked) locked.add(folder.id);
            if (Array.isArray(folder.children)) walk(folder.children, isLocked);
        }
    };
    walk(folders, false);
    return locked;
}

/**
 * Validates the authorization-relevant structure of root metadata, builds the
 * new snapshot locally, and only then assigns it. Valid `folders: []` is a
 * legitimate "ready, nothing locked" library; a missing/non-array `folders` or a
 * malformed node is not, and leaves `target` completely untouched.
 */
export function publishLockSnapshot(target: LockSnapshotTarget, metadata: unknown, now: () => number = Date.now): SnapshotResult {
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return { ok: false, reason: 'root metadata is not an object' };
    }
    const meta = metadata as Record<string, unknown>;
    const error = validateFolders(meta.folders, 'folders');
    if (error) return { ok: false, reason: error };

    const folders = meta.folders as any[];
    const lockedFolderIds = collectLocked(folders);
    const tagsGroups = Array.isArray(meta.tagsGroups) ? meta.tagsGroups : [];
    const stamp = Math.max(1, now()); // never 0: that would read as unready

    // Publish (synchronous block: no reader can observe a half-updated snapshot)
    target.folders = folders;
    target.tagsGroups = tagsGroups;
    target.lockedFolderIds = lockedFolderIds;
    target.lastUpdated = stamp;
    return { ok: true };
}

/**
 * Best-effort, coalesced lock-state initialization. Overlapping callers share
 * one in-flight attempt; the slot is cleared when the attempt settles
 * (success, failure or rejection), so a failed attempt never wedges it.
 * With the default `retryIntervalMs` of 0 there is no backoff: while the state
 * stays unready every later sequential call starts a fresh attempt (a full
 * library scan in production). A positive interval makes callers skip a new
 * attempt until that long after the previous one settled without becoming
 * ready; it never delays or weakens readiness checks (still fail-closed) and
 * a successful attempt needs no retry at all. Callers must re-check readiness.
 */
export function createLockInitializer(
    isReady: () => boolean,
    attempt: () => Promise<unknown>,
    enabled: () => boolean = () => true,
    { retryIntervalMs = 0, now = Date.now }: { retryIntervalMs?: number; now?: () => number } = {}
): () => Promise<void> {
    let loading: Promise<void> | null = null;
    let lastSettled = -Infinity;
    return async () => {
        if (isReady() || !enabled()) return;
        if (!loading) {
            const since = now() - lastSettled;
            if (retryIntervalMs > 0 && since >= 0 && since < retryIntervalMs) return;
            loading = Promise.resolve()
                .then(attempt)
                .then(() => undefined, () => undefined)
                .finally(() => { lastSettled = now(); loading = null; });
        }
        await loading;
    };
}

export function lockStateFromCache(cache: LockSnapshotTarget): LockState {
    return { ready: cache.lastUpdated > 0, folders: cache.folders, lockedFolderIds: cache.lockedFolderIds };
}
