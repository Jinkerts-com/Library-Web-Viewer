import crypto from 'crypto';

// Per-process secret: unlock cookies stop verifying (folders re-lock) when
// the server restarts. Cached on globalThis so dev-mode HMR reloads of this
// module don't invalidate existing unlocks mid-session.
declare global {
    var __unlockSecret: Buffer | undefined;
}
const secret: Buffer = globalThis.__unlockSecret ?? (globalThis.__unlockSecret = crypto.randomBytes(32));

export function signFolderId(folderId: string): string {
    return crypto.createHmac('sha256', secret).update(folderId).digest('hex');
}

function verifyFolderId(folderId: string, signature: string): boolean {
    const expected = Buffer.from(signFolderId(folderId));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Constant-time comparison that doesn't leak password length
export function safeEquals(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

const COOKIE_PREFIX = 'unlocked_';

export function unlockCookie(folderId: string): string {
    return `${COOKIE_PREFIX}${encodeURIComponent(folderId)}=${signFolderId(folderId)}; HttpOnly; Path=/; SameSite=Lax`;
}

export function expireUnlockCookie(folderId: string): string {
    return `${COOKIE_PREFIX}${encodeURIComponent(folderId)}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

// Folder ids whose unlock cookies carry a valid signature
export function getUnlockedFolderIds(request: Request): Set<string> {
    const ids = new Set<string>();
    const cookieHeader = request.headers.get('cookie');
    if (!cookieHeader) return ids;

    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name.startsWith(COOKIE_PREFIX) && value) {
            const folderId = decodeURIComponent(name.slice(COOKIE_PREFIX.length));
            if (verifyFolderId(folderId, value)) ids.add(folderId);
        }
    }
    return ids;
}
