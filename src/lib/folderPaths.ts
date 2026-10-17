/**
 * Folder-path resolution and breadcrumb construction. Pure (no store/DOM
 * access) so LockScreen, the header breadcrumb and tests share one traversal.
 */

export interface FolderNode {
    id: string;
    name: string;
    children?: FolderNode[];
}

export type SpecialFilter = 'uncategorized' | 'untagged' | 'random' | 'trash';

// Same wording as the sidebar's "My Media" entries
export const ROOT_LABEL = 'All';
export const SPECIAL_VIEW_LABELS: Record<SpecialFilter, string> = {
    uncategorized: 'Uncategorized',
    untagged: 'Untagged',
    random: 'Random',
    trash: 'Trash',
};
export const UNKNOWN_FOLDER_LABEL = 'Unknown folder';
export const UNTITLED_FOLDER_LABEL = 'Untitled folder';

export function specialViewLabel(filter: string | null | undefined): string | null {
    if (!filter || !Object.prototype.hasOwnProperty.call(SPECIAL_VIEW_LABELS, filter)) return null;
    return SPECIAL_VIEW_LABELS[filter as SpecialFilter];
}

/**
 * Ancestor chain from a top-level folder down to the folder with `id`
 * (inclusive), or null when the id is empty/unknown. Tolerates corrupt data:
 * non-array `children`, non-object entries, and cyclic or shared node
 * references (each node object is visited at most once, so it always ends).
 */
export function findFolderPath<T extends { id: string; children?: T[] }>(
    folders: readonly T[] | null | undefined,
    id: string | null | undefined,
): T[] | null {
    if (!id || !Array.isArray(folders)) return null;
    const visited = new Set<object>();

    const walk = (nodes: readonly T[], trail: T[]): T[] | null => {
        for (const node of nodes) {
            if (!node || typeof node !== 'object' || visited.has(node)) continue;
            visited.add(node);
            const next = [...trail, node];
            if (node.id === id) return next;
            if (Array.isArray(node.children)) {
                const found = walk(node.children, next);
                if (found) return found;
            }
        }
        return null;
    };

    return walk(folders, []);
}

/**
 * The folder holding the password that guards `id`: the nearest self-or-ancestor
 * with `hasPassword` (locks cascade down from it), or null when none.
 */
export function findProtectedFolder<T extends { id: string; children?: T[]; hasPassword?: boolean }>(
    folders: readonly T[] | null | undefined,
    id: string | null | undefined,
): T | null {
    const path = findFolderPath(folders, id) || [];
    return [...path].reverse().find(f => f.hasPassword) ?? null;
}

export interface Crumb {
    key: string;
    label: string;
    /** Folder to select on click; null = the "All" root. Only meaningful when navigable. */
    folderId: string | null;
    navigable: boolean;
    current: boolean;
}

/**
 * Breadcrumb trail for the current view. Special views (trash, random, ...)
 * take priority over a folder id, matching the grid's own filter precedence.
 * Unknown folder ids degrade to "All > Unknown folder" instead of failing.
 */
export function buildBreadcrumbs(
    folders: readonly FolderNode[] | null | undefined,
    view: { folderId: string | null; specialFilter: string | null },
): Crumb[] {
    const special = specialViewLabel(view.specialFilter);
    if (special) {
        return [{ key: `special:${view.specialFilter}`, label: special, folderId: null, navigable: false, current: true }];
    }

    if (!view.folderId) {
        return [{ key: 'root', label: ROOT_LABEL, folderId: null, navigable: false, current: true }];
    }

    const root: Crumb = { key: 'root', label: ROOT_LABEL, folderId: null, navigable: true, current: false };
    const path = findFolderPath(folders, view.folderId);
    if (!path) {
        return [root, { key: `missing:${view.folderId}`, label: UNKNOWN_FOLDER_LABEL, folderId: view.folderId, navigable: false, current: true }];
    }

    return [
        root,
        ...path.map((folder, i): Crumb => {
            const current = i === path.length - 1;
            return {
                key: `folder:${folder.id}`,
                label: typeof folder.name === 'string' && folder.name.trim() ? folder.name : UNTITLED_FOLDER_LABEL,
                folderId: folder.id,
                navigable: !current,
                current,
            };
        }),
    ];
}
