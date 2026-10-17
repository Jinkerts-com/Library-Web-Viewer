import { safeEquals, unlockCookie, expireUnlockCookie, shouldUseSecureCookie } from './unlock';
import type { GuardContext, RequestGuard } from './requestSecurity';

/**
 * POST /api/unlock and POST /api/lock. Response shapes are unchanged:
 *   unlock: 200 { success, unlockedIds } + Set-Cookie | 400 | 401 | 404
 *   lock:   200 { success, lockedIds }   + Set-Cookie | 400 | 404
 * The guard (same-origin 403 / rate limit 429) runs before the body is read.
 */

export interface FolderLike {
    id: string;
    password?: string | null;
}

export interface UnlockHandlerDeps<F extends FolderLike> {
    guard: RequestGuard;
    findFolder: (id: string) => F | null;
    subtreeIds: (folder: F) => Iterable<string>;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export function createUnlockHandler<F extends FolderLike>({ guard, findFolder, subtreeIds }: UnlockHandlerDeps<F>) {
    return async (ctx: GuardContext): Promise<Response> => {
        const blocked = guard(ctx);
        if (blocked) return blocked;
        const { request } = ctx;

        let folderId: unknown, password: unknown;
        try {
            ({ folderId, password } = await request.json());
        } catch (e) {
            return json({ success: false, error: 'Invalid request' }, 400);
        }

        if (typeof folderId !== 'string' || typeof password !== 'string' || !password) {
            return json({ success: false, error: 'Invalid request' }, 400);
        }

        const folder = findFolder(folderId);
        if (!folder || !folder.password) {
            return json({ success: false, error: 'Folder not found' }, 404);
        }

        // Accepted stored formats (pinned by tests/requestSecurity.test.ts):
        // Eagle stores folder passwords Base64-encoded in metadata.json (observed in the
        // test library); a plaintext match is also accepted in case other versions store
        // it raw. Encoding semantics are intentionally unchanged until real Eagle
        // fixtures justify removing the raw fallback.
        const decoded = Buffer.from(folder.password, 'base64').toString('utf8');
        if (!safeEquals(decoded, password) && !safeEquals(folder.password, password)) {
            return json({ success: false, error: 'Incorrect password' }, 401);
        }

        // Unlocking a folder unlocks its whole subtree
        const unlockedIds = Array.from(subtreeIds(folder));

        return json({ success: true, unlockedIds }, 200, {
            'Set-Cookie': unlockCookie(folderId, { secure: shouldUseSecureCookie(request) })
        });
    };
}

export function createLockHandler<F extends FolderLike>({ guard, findFolder, subtreeIds }: UnlockHandlerDeps<F>) {
    return async (ctx: GuardContext): Promise<Response> => {
        const blocked = guard(ctx);
        if (blocked) return blocked;
        const { request } = ctx;

        let folderId: unknown;
        try {
            ({ folderId } = await request.json());
        } catch (e) {
            return json({ success: false, error: 'Invalid request' }, 400);
        }

        if (typeof folderId !== 'string') {
            return json({ success: false, error: 'Invalid request' }, 400);
        }

        const folder = findFolder(folderId);
        if (!folder) {
            return json({ success: false, error: 'Folder not found' }, 404);
        }

        // Re-locking covers the same subtree the unlock uncovered
        const lockedIds = Array.from(subtreeIds(folder));

        return json({ success: true, lockedIds }, 200, {
            'Set-Cookie': expireUnlockCookie(folderId, { secure: shouldUseSecureCookie(request) })
        });
    };
}
