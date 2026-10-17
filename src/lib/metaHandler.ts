import { getUnlockedFolderIds } from './unlock';

/**
 * GET /api/meta. Initialization is tracked by lock-metadata readiness
 * (`lastUpdated > 0`, the same flag the fail-closed item/media routes use), NOT
 * by `folders.length`: a legitimately folderless library is ready after its
 * first successful load and is never rescanned by later metadata requests.
 * While unready, `ensureLockState` makes a coalesced, retry-throttled attempt;
 * the response keeps its shape (empty lists, nothing locked is NOT implied:
 * item/media routes still answer 503 until ready) with an additive `ready` flag.
 */

export interface MetaFolder {
    id: string;
    password?: string | null;
    children?: MetaFolder[];
}

export interface MetaCache<F extends MetaFolder = MetaFolder> {
    folders: F[];
    allTags: string[];
    tagCounts: Record<string, number>;
    tagsGroups: unknown[];
    lockedFolderIds: Set<string>;
    lastUpdated: number;
}

export interface MetaHandlerDeps<F extends MetaFolder = MetaFolder> {
    ensureLockState: () => Promise<void>;
    getCache: () => MetaCache<F>;
    findFolder: (id: string) => F | null;
    subtreeIds: (folder: F) => Iterable<string>;
}

// Never send folder passwords to the client; expose only whether a password
// exists (hasPassword) and the user-facing hint (passwordTips)
export function sanitizeFolders(folders: MetaFolder[]): Record<string, unknown>[] {
    return folders.map(({ password, children, ...rest }) => ({
        ...rest,
        hasPassword: !!(password && password.length > 0),
        children: children ? sanitizeFolders(children) : []
    }));
}

export function createMetaHandler<F extends MetaFolder>({ ensureLockState, getCache, findFolder, subtreeIds }: MetaHandlerDeps<F>) {
    return async ({ request }: { request: Request }): Promise<Response> => {
        await ensureLockState();
        const cache = getCache();

        // Folders this client already unlocked (valid session cookie), so the UI
        // stays unlocked across page reloads
        const unlockedIds = new Set<string>();
        getUnlockedFolderIds(request).forEach(id => {
            const folder = findFolder(id);
            if (folder) for (const sub of subtreeIds(folder)) unlockedIds.add(sub);
        });

        return new Response(JSON.stringify({
            folders: sanitizeFolders(cache.folders),
            tags: cache.allTags,
            tagCounts: cache.tagCounts,
            tagsGroups: cache.tagsGroups,
            lockedFolderIds: Array.from(cache.lockedFolderIds),
            unlockedFolderIds: Array.from(unlockedIds),
            ready: cache.lastUpdated > 0
        }), {
            headers: {
                "Content-Type": "application/json"
            }
        });
    };
}
