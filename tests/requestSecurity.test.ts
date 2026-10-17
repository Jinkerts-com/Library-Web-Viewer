import { describe, expect, test } from "bun:test";
import { createCooldown, createRateLimiter, readNonNegativeInt, readPositiveInt } from '../src/lib/rateLimit';
import {
    checkSameOrigin, createGuardedScanRoute, createMutationGuard, resolveClientAddress,
    type GuardContext
} from '../src/lib/requestSecurity';
import { createLockHandler, createUnlockHandler, type FolderLike } from '../src/lib/unlockHandlers';
import { getUnlockedFolderIds, shouldUseSecureCookie, signFolderId } from '../src/lib/unlock';
import { createMetaHandler, type MetaCache, type MetaFolder } from '../src/lib/metaHandler';
import { createLockInitializer } from '../src/lib/lockSnapshot';
import type { StartScanResult } from '../src/lib/scanLifecycle';

const HOST = 'lib.local:4321';

function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function post(body: unknown, headers: Record<string, string> = {}, url = `http://${HOST}/api/x`): Request {
    return new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: HOST, ...headers },
        body: JSON.stringify(body)
    });
}

const ctxOf = (request: Request, clientAddress: string | undefined = '10.0.0.1'): GuardContext => ({ request, clientAddress });

describe('rate limiter', () => {
    test('allows N requests then rejects N+1 with a Retry-After', () => {
        const c = clock();
        const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
        for (let i = 0; i < 3; i++) expect(limiter.take('a').allowed).toBe(true);
        const denied = limiter.take('a');
        expect(denied).toEqual({ allowed: false, retryAfterSeconds: 60 });
        c.advance(20_500);
        expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 40 });
    });

    test('expiry restores the allowance (no permanent lockout, rejections do not extend the window)', () => {
        const c = clock();
        const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: c.now });
        limiter.take('a'); limiter.take('a');
        for (let i = 0; i < 50; i++) { expect(limiter.take('a').allowed).toBe(false); c.advance(10); }
        c.advance(1000);
        expect(limiter.take('a').allowed).toBe(true);
    });

    test('keys have separate buckets', () => {
        const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock().now });
        expect(limiter.take('a').allowed).toBe(true);
        expect(limiter.take('a').allowed).toBe(false);
        expect(limiter.take('b').allowed).toBe(true);
    });

    test('storage is bounded: expired entries are evicted and the key cap holds under a flood', () => {
        const c = clock();
        const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 100, now: c.now });
        for (let i = 0; i < 100; i++) limiter.take(`k${i}`);
        expect(limiter.size).toBe(100);
        c.advance(1001);
        limiter.take('fresh');
        expect(limiter.size).toBe(1); // all 100 expired entries were dropped

        for (let i = 0; i < 5000; i++) { limiter.take(`flood${i}`); expect(limiter.size).toBeLessThanOrEqual(100); }
        expect(limiter.size).toBe(100);
    });

    test('DOCUMENTED TRADEOFF: at the key cap the oldest entry is evicted even if it is still blocked, restoring its allowance', () => {
        const c = clock();
        const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: c.now });
        expect(limiter.take('victim').allowed).toBe(true);
        expect(limiter.take('victim').allowed).toBe(false); // actively blocked
        limiter.take('other');
        expect(limiter.size).toBe(2);
        limiter.take('flood'); // new key at the cap evicts the oldest ('victim'), still within its window
        expect(limiter.size).toBe(2);
        // Accepted tradeoff: memory stays bounded at the cost of an evicted blocked key getting a fresh allowance.
        expect(limiter.take('victim').allowed).toBe(true);
    });

    test('a backwards clock jump does not wedge a key', () => {
        const c = clock(10_000_000);
        const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: c.now });
        limiter.take('a');
        c.advance(-5_000_000);
        expect(limiter.take('a').allowed).toBe(true);
    });

    test('rejects nonsensical configuration; env parsing falls back to defaults', () => {
        expect(() => createRateLimiter({ limit: 0, windowMs: 1000 })).toThrow();
        expect(readPositiveInt(undefined, 7)).toBe(7);
        expect(readPositiveInt('0', 7)).toBe(7);
        expect(readPositiveInt('abc', 7)).toBe(7);
        expect(readPositiveInt('12', 7)).toBe(12);
        expect(readNonNegativeInt('0', 7)).toBe(0);
        expect(readNonNegativeInt('-1', 7)).toBe(7);
    });
});

describe('cooldown', () => {
    test('rejects after start, then expires', () => {
        const c = clock();
        const cooldown = createCooldown({ ms: 10_000, now: c.now });
        expect(cooldown.check().allowed).toBe(true);
        cooldown.start();
        expect(cooldown.check()).toEqual({ allowed: false, retryAfterSeconds: 10 });
        c.advance(9_001);
        expect(cooldown.check()).toEqual({ allowed: false, retryAfterSeconds: 1 });
        c.advance(1000);
        expect(cooldown.check().allowed).toBe(true);
    });

    test('0 ms disables it', () => {
        const cooldown = createCooldown({ ms: 0, now: clock().now });
        cooldown.start();
        expect(cooldown.check().allowed).toBe(true);
    });
});

describe('client address', () => {
    test('uses the adapter-provided address and ignores spoofable forwarding headers', () => {
        const spoof = post({}, { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7', forwarded: 'for=8.8.8.8' });
        expect(resolveClientAddress({ request: spoof, clientAddress: '192.168.1.5' })).toBe('192.168.1.5');
        expect(resolveClientAddress({ request: spoof, clientAddress: '::ffff:192.168.1.5' })).toBe('192.168.1.5');
    });

    test('missing/throwing adapter address maps to one shared bucket, never a header value', () => {
        const spoof = post({}, { 'x-forwarded-for': '6.6.6.6' });
        const throwing = { request: spoof, get clientAddress(): string { throw new Error('no address'); } };
        expect(resolveClientAddress(throwing)).toBe('unknown');
        expect(resolveClientAddress({ request: spoof })).toBe('unknown');
    });

    test('missing and throwing contexts share ONE bucket through a limiter (accepted conservative ruling), which recovers after the window', () => {
        const c = clock();
        const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
        const guard = createMutationGuard({ scope: 's', limiter });
        const spoof = () => post({}, { 'x-forwarded-for': '6.6.6.6' });
        const missing = () => ({ request: spoof() });
        const throwing = () => ({ request: spoof(), get clientAddress(): string { throw new Error('no address'); } });
        const contexts = [missing, throwing, missing, throwing, missing];
        const results = contexts.map(make => guard(make())?.status ?? 200);
        expect(results).toEqual([200, 200, 200, 429, 429]); // shared N+1 rejection
        expect(guard(ctxOf(post({}), '10.0.0.9'))).toBeNull(); // a real address is unaffected

        c.advance(60_001);
        expect(guard(throwing())).toBeNull(); // recovery after the window
        expect(guard(missing())).toBeNull();
    });

    test('rotating X-Forwarded-For does not escape the rate limit', () => {
        const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock().now });
        const guard = createMutationGuard({ scope: 's', limiter });
        const results = [1, 2, 3, 4].map(i =>
            guard(ctxOf(post({}, { 'x-forwarded-for': `9.9.9.${i}` }), '10.1.1.1'))?.status ?? 200);
        expect(results).toEqual([200, 200, 429, 429]);
    });

    test('different adapter addresses get different buckets; scopes do not share counters', () => {
        const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
        const a = createMutationGuard({ scope: 'a', limiter });
        const b = createMutationGuard({ scope: 'b', limiter });
        expect(a(ctxOf(post({}), '1.1.1.1'))).toBeNull();
        expect(a(ctxOf(post({}), '1.1.1.1'))?.status).toBe(429);
        expect(a(ctxOf(post({}), '2.2.2.2'))).toBeNull();
        expect(b(ctxOf(post({}), '1.1.1.1'))).toBeNull();
    });
});

describe('same-origin policy', () => {
    test('matching Origin is allowed', () => {
        expect(checkSameOrigin(post({}, { origin: `http://${HOST}` })).ok).toBe(true);
        expect(checkSameOrigin(post({}, { origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' })).ok).toBe(true);
    });

    test('mismatched, null or malformed Origin is rejected', () => {
        expect(checkSameOrigin(post({}, { origin: 'http://evil.example' })).ok).toBe(false);
        expect(checkSameOrigin(post({}, { origin: 'http://lib.local:9999' })).ok).toBe(false);
        expect(checkSameOrigin(post({}, { origin: 'null' })).ok).toBe(false);
        expect(checkSameOrigin(post({}, { origin: 'not a url' })).ok).toBe(false);
    });

    test('Sec-Fetch-Site cross-site / same-site is rejected even with a matching Origin; none is allowed', () => {
        expect(checkSameOrigin(post({}, { 'sec-fetch-site': 'cross-site' })).ok).toBe(false);
        expect(checkSameOrigin(post({}, { 'sec-fetch-site': 'same-site', origin: `http://${HOST}` })).ok).toBe(false);
        expect(checkSameOrigin(post({}, { 'sec-fetch-site': 'none' })).ok).toBe(true);
    });

    test('Referer is the fallback when Origin and Sec-Fetch-Site are absent', () => {
        expect(checkSameOrigin(post({}, { referer: `http://${HOST}/page` })).ok).toBe(true);
        expect(checkSameOrigin(post({}, { referer: 'http://evil.example/page' })).ok).toBe(false);
    });

    test('non-browser requests without Origin/Referer/Sec-Fetch-Site are allowed', () => {
        expect(checkSameOrigin(post({})).ok).toBe(true);
    });

    test('guard answers 403 for cross-origin and does not consume rate-limit budget', () => {
        const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
        const guard = createMutationGuard({ scope: 's', limiter });
        for (let i = 0; i < 5; i++) expect(guard(ctxOf(post({}, { origin: 'http://evil.example' })))?.status).toBe(403);
        expect(guard(ctxOf(post({}, { origin: `http://${HOST}` })))).toBeNull();
    });

    test('CLI (no Origin) is allowed but still rate limited', () => {
        const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock().now });
        const guard = createMutationGuard({ scope: 's', limiter });
        expect(guard(ctxOf(post({})))).toBeNull();
        expect(guard(ctxOf(post({})))).toBeNull();
        expect(guard(ctxOf(post({})))?.status).toBe(429);
    });
});

// ---- unlock / lock handlers -----------------------------------------------------

interface TestFolder extends FolderLike { children?: TestFolder[]; }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const folders: TestFolder[] = [
    { id: 'B64', password: b64('s3cret'), children: [{ id: 'B64-child' }] },
    { id: 'RAW', password: 'plain-pass' },
    // raw value that also happens to be valid Base64 text: still accepted raw
    { id: 'AMBIG', password: 'abcd' },
    { id: 'OPEN' }
];

function find(list: TestFolder[], id: string): TestFolder | null {
    for (const f of list) {
        if (f.id === id) return f;
        const hit = f.children && find(f.children, id);
        if (hit) return hit;
    }
    return null;
}
const subtree = (f: TestFolder): string[] => [f.id, ...(f.children ?? []).flatMap(subtree)];

function makeUnlock(opts: { limit?: number; c?: ReturnType<typeof clock> } = {}) {
    const c = opts.c ?? clock();
    const limiter = createRateLimiter({ limit: opts.limit ?? 5, windowMs: 60_000, now: c.now });
    const guard = createMutationGuard({ scope: 'unlock', limiter });
    const common = { guard, findFolder: (id: string) => find(folders, id), subtreeIds: subtree };
    return { unlock: createUnlockHandler(common), lock: createLockHandler(common), c };
}

const attempt = (folderId: string, password: unknown, headers: Record<string, string> = {}, url?: string, addr = '10.0.0.1') =>
    ctxOf(post({ folderId, password }, headers, url), addr);

describe('unlock password-format fixtures (current semantics pinned)', () => {
    test('Base64-stored password: decoded value is accepted, success shape + cookie', async () => {
        const { unlock } = makeUnlock();
        const res = await unlock(attempt('B64', 's3cret'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, unlockedIds: ['B64', 'B64-child'] });
        expect(res.headers.get('set-cookie')).toContain(`unlocked_B64=${signFolderId('B64')}`);
    });

    test('Base64-stored password: the encoded form itself is ALSO accepted (raw fallback)', async () => {
        const { unlock } = makeUnlock();
        expect((await unlock(attempt('B64', b64('s3cret')))).status).toBe(200);
    });

    test('raw-stored password is accepted', async () => {
        const { unlock } = makeUnlock();
        expect((await unlock(attempt('RAW', 'plain-pass'))).status).toBe(200);
    });

    test('a raw value that is valid Base64 text is accepted as typed (raw) and via its decoding', async () => {
        const { unlock } = makeUnlock();
        expect((await unlock(attempt('AMBIG', 'abcd'))).status).toBe(200);
        expect((await unlock(attempt('AMBIG', Buffer.from('abcd', 'base64').toString('utf8')))).status).toBe(200);
    });

    test('wrong password: 401, no cookie', async () => {
        const { unlock } = makeUnlock();
        const res = await unlock(attempt('B64', 'nope'));
        expect(res.status).toBe(401);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(await res.json()).toEqual({ success: false, error: 'Incorrect password' });
    });

    test('400 / 404 shapes are unchanged', async () => {
        const { unlock } = makeUnlock();
        expect((await unlock(attempt('B64', ''))).status).toBe(400);
        expect((await unlock(attempt('B64', 5))).status).toBe(400);
        expect((await unlock(ctxOf(new Request(`http://${HOST}/api/unlock`, { method: 'POST', headers: { host: HOST }, body: 'not json' })))).status).toBe(400);
        expect((await unlock(attempt('MISSING', 'x'))).status).toBe(404);
        expect((await unlock(attempt('OPEN', 'x'))).status).toBe(404); // unprotected folder
    });
});

describe('unlock brute-force protection', () => {
    test('attempt N+1 is 429 with Retry-After and no cookie, even for the right password; expiry restores access', async () => {
        const { unlock, c } = makeUnlock({ limit: 3 });
        for (let i = 0; i < 3; i++) expect((await unlock(attempt('B64', `guess${i}`))).status).toBe(401);
        const blocked = await unlock(attempt('B64', 's3cret'));
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('retry-after')).toBe('60');
        expect(blocked.headers.get('set-cookie')).toBeNull();
        expect((await blocked.json()).success).toBe(false);

        c.advance(60_001);
        expect((await unlock(attempt('B64', 's3cret'))).status).toBe(200);
    });

    test('another client address is not affected; spoofed XFF does not help the attacker', async () => {
        const { unlock } = makeUnlock({ limit: 1 });
        expect((await unlock(attempt('B64', 'x'))).status).toBe(401);
        expect((await unlock(attempt('B64', 'x', { 'x-forwarded-for': '5.5.5.5' }))).status).toBe(429);
        expect((await unlock(attempt('B64', 'x', {}, undefined, '10.0.0.2'))).status).toBe(401);
    });

    test('cross-origin unlock and lock are 403 before any password check', async () => {
        const { unlock, lock } = makeUnlock();
        const evil = { origin: 'http://evil.example' };
        const u = await unlock(attempt('B64', 's3cret', evil));
        expect(u.status).toBe(403);
        expect(u.headers.get('set-cookie')).toBeNull();
        expect((await lock(ctxOf(post({ folderId: 'B64' }, evil)))).status).toBe(403);
        expect((await unlock(attempt('B64', 's3cret', { origin: `http://${HOST}` }))).status).toBe(200);
    });
});

describe('unlock cookie Secure attribute', () => {
    test('plain HTTP: no Secure (LAN keeps working); session cookie without Max-Age', async () => {
        const { unlock } = makeUnlock();
        const cookie = (await unlock(attempt('B64', 's3cret'))).headers.get('set-cookie')!;
        expect(cookie).not.toContain('Secure');
        expect(cookie).not.toContain('Max-Age');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Lax');
    });

    test('HTTPS request: Secure', async () => {
        const { unlock } = makeUnlock();
        const cookie = (await unlock(attempt('B64', 's3cret', {}, `https://${HOST}/api/unlock`))).headers.get('set-cookie')!;
        expect(cookie).toContain('; Secure');
    });

    test('COOKIE_SECURE overrides the request scheme', () => {
        const http = post({});
        const https = post({}, {}, `https://${HOST}/x`);
        expect(shouldUseSecureCookie(http, { COOKIE_SECURE: 'true' })).toBe(true);
        expect(shouldUseSecureCookie(http, { COOKIE_SECURE: '1' })).toBe(true);
        expect(shouldUseSecureCookie(https, { COOKIE_SECURE: 'false' })).toBe(false);
        expect(shouldUseSecureCookie(http, {})).toBe(false);
        expect(shouldUseSecureCookie(https, {})).toBe(true);
        // a forwarded-proto header alone never turns Secure on
        expect(shouldUseSecureCookie(post({}, { 'x-forwarded-proto': 'https' }), {})).toBe(false);
    });

    test('lock: expiry cookie keeps Max-Age=0 and mirrors Secure; session HMAC behavior is unchanged', async () => {
        const { unlock, lock } = makeUnlock();
        const res = await lock(ctxOf(post({ folderId: 'B64' }, {}, `https://${HOST}/api/lock`)));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, lockedIds: ['B64', 'B64-child'] });
        const cookie = res.headers.get('set-cookie')!;
        expect(cookie).toContain('Max-Age=0');
        expect(cookie).toContain('; Secure');

        // the cookie issued by unlock still verifies through the same HMAC
        const issued = (await unlock(attempt('B64', 's3cret'))).headers.get('set-cookie')!.split(';')[0];
        expect([...getUnlockedFolderIds(new Request(`http://${HOST}/`, { headers: { cookie: issued } }))]).toEqual(['B64']);
        expect(getUnlockedFolderIds(new Request(`http://${HOST}/`, { headers: { cookie: 'unlocked_B64=forged' } })).size).toBe(0);
    });
});

// ---- scan route -------------------------------------------------------------------

function makeScan(opts: { limit?: number; cooldownMs?: number } = {}) {
    const c = clock();
    const limiter = createRateLimiter({ limit: opts.limit ?? 100, windowMs: 60_000, now: c.now });
    const cooldown = createCooldown({ ms: opts.cooldownMs ?? 10_000, now: c.now });
    let scanning = false;
    let finish: (how: 'success' | 'failure' | 'reject') => void = () => { };
    let starts = 0;
    const route = createGuardedScanRoute({
        guard: createMutationGuard({ scope: 'scan', limiter }),
        cooldown,
        isScanning: () => scanning,
        start: (): StartScanResult => {
            if (scanning) return { kind: 'busy' };
            starts++;
            scanning = true;
            return {
                kind: 'accepted',
                done: new Promise((resolve, reject) => {
                    const counts = { total: 0, scanned: 0, upserts: 0, skipped: 0, removed: 0, failedItems: 0 };
                    finish = (how) => {
                        scanning = false;
                        if (how === 'reject') reject(new Error('contract-violating rejection'));
                        else if (how === 'failure') resolve({ outcome: 'failure', reason: 'internal', error: 'The scan failed unexpectedly; see the server log for details.', ...counts });
                        else resolve({ outcome: 'success', ...counts });
                    };
                })
            };
        },
        log: { info() { }, error() { } }
    });
    return {
        route, c, starts: () => starts,
        finish: async (how: 'success' | 'failure' | 'reject' = 'success') => {
            finish(how);
            for (let i = 0; i < 5; i++) await Promise.resolve();
        }
    };
}

describe('scan route protection', () => {
    test('accepted keeps the P1.3 shape; a running scan still reports 409 busy', async () => {
        const s = makeScan();
        const first = await s.route(ctxOf(post({})));
        expect(first.status).toBe(200);
        expect((await first.json()).message).toBe('Scan started');
        const busy = await s.route(ctxOf(post({})));
        expect(busy.status).toBe(409);
        expect(s.starts()).toBe(1);
    });

    test('cooldown rejects shortly after completion (429 + Retry-After) and expires', async () => {
        const s = makeScan();
        expect((await s.route(ctxOf(post({})))).status).toBe(200);
        s.c.advance(30_000); // longer than the cooldown, scan still running
        await s.finish();    // completion restarts the cooldown
        const throttled = await s.route(ctxOf(post({})));
        expect(throttled.status).toBe(429);
        expect(throttled.headers.get('retry-after')).toBe('10');
        expect(s.starts()).toBe(1);

        s.c.advance(10_001);
        expect((await s.route(ctxOf(post({})))).status).toBe(200);
        expect(s.starts()).toBe(2);
    });

    test.each(['failure', 'reject'] as const)('cooldown also restarts after a %s terminal result', async (how) => {
        const s = makeScan();
        expect((await s.route(ctxOf(post({})))).status).toBe(200);
        s.c.advance(30_000); // longer than the cooldown, scan still running
        await s.finish(how);
        const throttled = await s.route(ctxOf(post({})));
        expect(throttled.status).toBe(429);
        expect(throttled.headers.get('retry-after')).toBe('10');
        expect(s.starts()).toBe(1);

        s.c.advance(10_001);
        expect((await s.route(ctxOf(post({})))).status).toBe(200);
        expect(s.starts()).toBe(2);
    });

    test('per-client rate limit applies to scans; cross-origin is 403 and starts nothing', async () => {
        const s = makeScan({ limit: 2, cooldownMs: 0 });
        expect((await s.route(ctxOf(post({}, { origin: 'http://evil.example' })))).status).toBe(403);
        expect(s.starts()).toBe(0);
        expect((await s.route(ctxOf(post({})))).status).toBe(200);
        await s.finish();
        expect((await s.route(ctxOf(post({})))).status).toBe(200);
        await s.finish();
        const limited = await s.route(ctxOf(post({})));
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect((await s.route(ctxOf(post({}), '10.9.9.9'))).status).toBe(200); // other client
    });
});

// ---- meta initialization ----------------------------------------------------------

function makeMeta(cache: MetaCache, attemptScan: () => Promise<void>, retryIntervalMs = 0, c = clock()) {
    let scans = 0;
    const ensureLockState = createLockInitializer(
        () => cache.lastUpdated > 0,
        async () => { scans++; await attemptScan(); },
        () => true,
        { retryIntervalMs, now: c.now }
    );
    const findFolder = (id: string): MetaFolder | null => {
        const walk = (list: MetaFolder[]): MetaFolder | null => {
            for (const f of list) { if (f.id === id) return f; const h = f.children && walk(f.children); if (h) return h; }
            return null;
        };
        return walk(cache.folders);
    };
    const handler = createMetaHandler({
        ensureLockState,
        getCache: () => cache,
        findFolder,
        subtreeIds: function* walk(f): Iterable<string> { yield f.id; for (const ch of f.children ?? []) yield* walk(ch); }
    });
    return { handler, scans: () => scans, c };
}

const emptyCache = (): MetaCache => ({ folders: [], allTags: [], tagCounts: {}, tagsGroups: [], lockedFolderIds: new Set(), lastUpdated: 0 });
const metaReq = () => ({ request: new Request(`http://${HOST}/api/meta`) });

describe('meta initialization', () => {
    test('folderless library: first GET initializes, later GETs do not rescan', async () => {
        const cache = emptyCache();
        const m = makeMeta(cache, async () => { cache.lastUpdated = 5; }); // valid metadata with folders: []
        const first = await (await m.handler(metaReq())).json();
        expect(first.ready).toBe(true);
        expect(first.folders).toEqual([]);
        for (let i = 0; i < 5; i++) await m.handler(metaReq());
        expect(m.scans()).toBe(1);
    });

    test('unready stays fail-closed and visible (ready:false), retries are throttled, then resume', async () => {
        const cache = emptyCache();
        let succeed = false;
        const m = makeMeta(cache, async () => { if (succeed) cache.lastUpdated = 9; }, 3000);
        expect((await (await m.handler(metaReq())).json()).ready).toBe(false);
        await m.handler(metaReq());
        await m.handler(metaReq());
        expect(m.scans()).toBe(1); // throttled
        m.c.advance(3001);
        succeed = true;
        expect((await (await m.handler(metaReq())).json()).ready).toBe(true);
        expect(m.scans()).toBe(2);
        await m.handler(metaReq());
        expect(m.scans()).toBe(2);
    });

    test('passwords are never exposed; locked/unlocked ids and shape are preserved', async () => {
        const cache = emptyCache();
        cache.folders = [{ id: 'L', password: b64('pw'), passwordTips: 'hint', children: [{ id: 'L2' }] } as MetaFolder];
        cache.lockedFolderIds = new Set(['L', 'L2']);
        cache.lastUpdated = 1;
        const m = makeMeta(cache, async () => { });
        const cookie = `unlocked_L=${signFolderId('L')}`;
        const body = await (await m.handler({ request: new Request(`http://${HOST}/api/meta`, { headers: { cookie } }) })).json();
        expect(JSON.stringify(body)).not.toContain(b64('pw'));
        expect(body.folders[0]).toMatchObject({ id: 'L', hasPassword: true, passwordTips: 'hint' });
        expect(body.lockedFolderIds).toEqual(['L', 'L2']);
        expect(body.unlockedFolderIds).toEqual(['L', 'L2']);
        expect(m.scans()).toBe(0);
    });

    test('overlapping first requests coalesce into one initialization', async () => {
        const cache = emptyCache();
        const m = makeMeta(cache, async () => { await new Promise(r => setTimeout(r, 5)); cache.lastUpdated = 1; });
        await Promise.all([m.handler(metaReq()), m.handler(metaReq()), m.handler(metaReq())]);
        expect(m.scans()).toBe(1);
    });
});
