import { getUnlockedFolderIds } from './unlock';
import { isSafeItemId } from './mediaPaths';

/**
 * Shared server-side authorization for items. Pure (no import-time side
 * effects): production state is injected by `mediaAccess.ts`, tests inject
 * fixtures. Fail-closed throughout: unknown ids, unparsable membership, lookup
 * errors and unloaded lock metadata all deny.
 */

export interface FolderNode {
    id: string;
    children?: FolderNode[];
    [key: string]: unknown;
}

export interface LockState {
    /** True only once folder/lock metadata has loaded successfully. "Not loaded" is never "nothing locked". */
    ready: boolean;
    folders: FolderNode[];
    lockedFolderIds: ReadonlySet<string>;
}

export interface AccessItem {
    id: string;
    name: string;
    ext: string;
    folders: string[];
}

export interface AccessDeps {
    getLockState: () => LockState;
    /** Returns the DB row for an id, or null if it does not exist. May throw (treated as denial). */
    lookupItem: (id: string) => AccessItem | null;
}

export type AccessDecision =
    | { ok: true; item: AccessItem }
    // 404: unknown, locked and malformed ids are indistinguishable; 503: lock metadata not ready yet
    | { ok: false; status: 404 | 503 };

function findFolder(folders: FolderNode[], id: string): FolderNode | null {
    for (const folder of folders) {
        if (folder.id === id) return folder;
        if (folder.children) {
            const found = findFolder(folder.children, id);
            if (found) return found;
        }
    }
    return null;
}

function collectSubtreeIds(folder: FolderNode, into: Set<string>) {
    into.add(folder.id);
    folder.children?.forEach(child => collectSubtreeIds(child, into));
}

/**
 * Locked folder ids still locked for a client: the locked set minus the
 * subtrees of folders it holds a valid unlock cookie for (unlocking a folder
 * uncovers all its descendants). Returns null when lock metadata is not ready.
 */
export function effectiveLockedFolderIds(state: LockState, unlocked: Iterable<string>): Set<string> | null {
    if (!state.ready) return null;
    const effective = new Set(state.lockedFolderIds);
    for (const id of unlocked) {
        const folder = findFolder(state.folders, id);
        if (!folder) continue;
        const subtree = new Set<string>();
        collectSubtreeIds(folder, subtree);
        subtree.forEach(sub => effective.delete(sub));
    }
    return effective;
}

/** Locked-folder set for a request (cookie-aware); null when lock metadata is not ready. */
export function lockedFolderIdsForRequest(state: LockState, request: Request): Set<string> | null {
    return effectiveLockedFolderIds(state, getUnlockedFolderIds(request));
}

/** Resolves the id to a DB row, then checks folder locks. Must run before any media or cache access. */
export function authorizeItem(deps: AccessDeps, request: Request, id: unknown): AccessDecision {
    if (!isSafeItemId(id)) return { ok: false, status: 404 };

    let locked: Set<string> | null;
    try {
        locked = lockedFolderIdsForRequest(deps.getLockState(), request);
    } catch {
        return { ok: false, status: 503 };
    }
    if (!locked) return { ok: false, status: 503 };

    let item: AccessItem | null;
    try {
        item = deps.lookupItem(id);
    } catch {
        return { ok: false, status: 404 };
    }
    if (!item || !Array.isArray(item.folders)) return { ok: false, status: 404 };
    if (item.folders.some(folderId => typeof folderId !== 'string' || locked!.has(folderId))) {
        return { ok: false, status: 404 };
    }
    return { ok: true, item };
}

/** Parses the DB `folders` JSON column; unparsable/non-array membership yields null (callers deny). */
export function parseFolderMembership(raw: unknown): string[] | null {
    if (raw === null || raw === undefined || raw === '') return [];
    if (typeof raw !== 'string') return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.every(f => typeof f === 'string') ? parsed : null;
    } catch {
        return null;
    }
}
