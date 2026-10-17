import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AccessDeps, AccessItem, LockState } from '../src/lib/itemAccess';
import { createOriginalHandler } from '../src/lib/mediaHandlers';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const items: Record<string, AccessItem> = {
    pic: { id: 'pic', name: 'a', ext: 'png', folders: [] },
    big: { id: 'big', name: 'big', ext: 'mp4', folders: [] },
    vec: { id: 'vec', name: 'v', ext: 'svg', folders: [] },
    empty: { id: 'empty', name: 'e', ext: 'png', folders: [] },
    aud: { id: 'aud', name: 'a', ext: 'OGG', folders: [] },
    locked: { id: 'locked', name: 'l', ext: 'png', folders: ['L'] },
};
const state: LockState = { ready: true, folders: [{ id: 'L', children: [] }], lockedFolderIds: new Set(['L']) };
const access: AccessDeps = { getLockState: () => state, lookupItem: id => items[id] ?? null };

const ALPHABET = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const bigData = crypto.randomBytes(6 * 1024 * 1024);

function setup(extra: { openFile?: Parameters<typeof createOriginalHandler>[0]['openFile'] } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwv-range-'));
    dirs.push(root);
    const lib = path.join(root, 'Library.library');
    const write = (id: string, name: string, data: Buffer | string) => {
        const d = path.join(lib, 'images', `${id}.info`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, name), data);
    };
    write('pic', 'a.png', ALPHABET);
    write('big', 'big.mp4', bigData);
    write('vec', 'v.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    write('empty', 'e.png', '');
    write('aud', 'a.OGG', ALPHABET);
    write('locked', 'l.png', 'SECRET');
    return createOriginalHandler({ access, getLibraryPath: () => lib, ...extra });
}

const get = (handler: ReturnType<typeof setup>, p: string, headers: Record<string, string> = {}, method = 'GET') =>
    handler({ params: { path: p }, request: new Request('http://l/x', { method, headers }) } as any) as Promise<Response>;

/** Handler over the same fixtures whose file-open seam records opens and closes. */
function setupSpy(beforeOpen?: (file: string) => void) {
    const opened: string[] = [];
    let closed = 0;
    const handler = setup({
        openFile: async (file, flags) => {
            opened.push(file);
            beforeOpen?.(file);
            const handle = await fs.promises.open(file, flags);
            const close = handle.close.bind(handle);
            handle.close = async () => { closed++; return close(); };
            return handle;
        },
    });
    return { handler, opened, closes: () => closed };
}

describe('original handler ranges', () => {
    test('full response: 200, exact bytes, length, Accept-Ranges, nosniff', async () => {
        const res = await get(setup(), 'pic.info/a.png');
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/png');
        expect(res.headers.get('Content-Length')).toBe(String(ALPHABET.length));
        expect(res.headers.get('Accept-Ranges')).toBe('bytes');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Content-Range')).toBeNull();
        expect(Buffer.from(await res.arrayBuffer()).equals(ALPHABET)).toBe(true);
    });

    test('explicit range: 206, exact slice and headers', async () => {
        const res = await get(setup(), 'pic.info/a.png', { range: 'bytes=2-5' });
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe(`bytes 2-5/${ALPHABET.length}`);
        expect(res.headers.get('Content-Length')).toBe('4');
        expect(await res.text()).toBe('2345');
    });

    test('open-ended range', async () => {
        const res = await get(setup(), 'pic.info/a.png', { range: 'bytes=30-' });
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe(`bytes 30-35/36`);
        expect(await res.text()).toBe('uvwxyz');
    });

    test('suffix range', async () => {
        const res = await get(setup(), 'pic.info/a.png', { range: 'bytes=-4' });
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 32-35/36');
        expect(res.headers.get('Content-Length')).toBe('4');
        expect(await res.text()).toBe('wxyz');
    });

    test('suffix longer than file returns the whole file as 206', async () => {
        const res = await get(setup(), 'pic.info/a.png', { range: 'bytes=-9999' });
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 0-35/36');
        expect(Buffer.from(await res.arrayBuffer()).equals(ALPHABET)).toBe(true);
    });

    test('unsatisfiable: 416 with bytes */size and no body', async () => {
        const handler = setup();
        for (const range of ['bytes=999999999-', 'bytes=36-', 'bytes=5-2', 'bytes=-0']) {
            const res = await get(handler, 'pic.info/a.png', { range });
            expect([range, res.status]).toEqual([range, 416]);
            expect(res.headers.get('Content-Range')).toBe('bytes */36');
            expect(await res.text()).toBe('');
        }
    });

    test('empty file: full is 200/0 bytes, any range is 416 bytes */0', async () => {
        const handler = setup();
        const full = await get(handler, 'empty.info/e.png');
        expect(full.status).toBe(200);
        expect(full.headers.get('Content-Length')).toBe('0');
        expect((await full.arrayBuffer()).byteLength).toBe(0);
        for (const range of ['bytes=0-0', 'bytes=0-', 'bytes=-5']) {
            const res = await get(handler, 'empty.info/e.png', { range });
            expect([range, res.status]).toEqual([range, 416]);
            expect(res.headers.get('Content-Range')).toBe('bytes */0');
        }
    });

    test('malformed and multi-range headers are ignored: full 200', async () => {
        const handler = setup();
        for (const range of ['bytes=abc', 'bytes=0-1,4-5', 'items=0-3', 'bytes=-']) {
            const res = await get(handler, 'pic.info/a.png', { range });
            expect([range, res.status]).toEqual([range, 200]);
            expect(await res.text()).toBe(ALPHABET.toString());
        }
    });

    test('large file streams fully and by slice (6 MiB)', async () => {
        const handler = setup();
        const full = await get(handler, 'big.info/big.mp4');
        expect(full.status).toBe(200);
        expect(full.headers.get('Content-Type')).toBe('video/mp4');
        expect(full.headers.get('Content-Length')).toBe(String(bigData.length));
        expect(Buffer.from(await full.arrayBuffer()).equals(bigData)).toBe(true);

        const mid = await get(handler, 'big.info/big.mp4', { range: 'bytes=1000000-1999999' });
        expect(mid.status).toBe(206);
        expect(mid.headers.get('Content-Range')).toBe(`bytes 1000000-1999999/${bigData.length}`);
        expect(Buffer.from(await mid.arrayBuffer()).equals(bigData.subarray(1000000, 2000000))).toBe(true);

        const tail = await get(handler, 'big.info/big.mp4', { range: 'bytes=-100' });
        expect(Buffer.from(await tail.arrayBuffer()).equals(bigData.subarray(bigData.length - 100))).toBe(true);
    });

    test('cancelling a streamed body closes the file handle and does not break later requests', async () => {
        const { handler, opened, closes } = setupSpy();
        const res = await get(handler, 'big.info/big.mp4');
        expect(opened.length).toBe(1);
        const reader = res.body!.getReader();
        await reader.read(); // stream is live and holding the handle
        expect(closes()).toBe(0);
        await reader.cancel();
        for (let i = 0; i < 100 && closes() < 1; i++) await new Promise(r => setTimeout(r, 20));
        expect(closes()).toBe(1);

        const again = await get(handler, 'big.info/big.mp4', { range: 'bytes=0-9' });
        expect(Buffer.from(await again.arrayBuffer()).equals(bigData.subarray(0, 10))).toBe(true);
        for (let i = 0; i < 100 && closes() < 2; i++) await new Promise(r => setTimeout(r, 20));
        expect(closes()).toBe(2); // fully consumed streams release their handle too
    });

    test('file vanishing between authorization and open yields the placeholder', async () => {
        const { handler, opened } = setupSpy(file => fs.rmSync(file, { force: true }));
        const res = await get(handler, 'pic.info/a.png');
        expect(opened.length).toBe(1);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
        expect(await res.text()).toContain('No Preview');
    });

    describe('HEAD ignores Range (RFC 9110 14.2) and never opens the file', () => {
        const fullHeaders = async (res: Response, length: number, type: string) => {
            expect(res.status).toBe(200);
            expect(res.headers.get('Content-Length')).toBe(String(length));
            expect(res.headers.get('Content-Type')).toBe(type);
            expect(res.headers.get('Accept-Ranges')).toBe('bytes');
            expect(res.headers.get('Content-Range')).toBeNull();
            expect((await res.arrayBuffer()).byteLength).toBe(0);
        };

        test('no Range, satisfiable Range, unsatisfiable Range', async () => {
            const { handler, opened } = setupSpy();
            for (const range of [undefined, 'bytes=0-9', 'bytes=-4', 'bytes=999999-', 'bytes=5-2']) {
                const res = await get(handler, 'pic.info/a.png', range ? { range } : {}, 'HEAD');
                await fullHeaders(res, ALPHABET.length, 'image/png');
            }
            expect(opened).toEqual([]);
        });

        test('empty file', async () => {
            const { handler, opened } = setupSpy();
            for (const range of [undefined, 'bytes=0-0', 'bytes=-5']) {
                const res = await get(handler, 'empty.info/e.png', range ? { range } : {}, 'HEAD');
                await fullHeaders(res, 0, 'image/png');
            }
            expect(opened).toEqual([]);
        });

        test('large file HEAD with Range reports the full length', async () => {
            const { handler, opened } = setupSpy();
            const res = await get(handler, 'big.info/big.mp4', { range: 'bytes=0-9' }, 'HEAD');
            await fullHeaders(res, bigData.length, 'video/mp4');
            expect(opened).toEqual([]);
        });

        test('matching If-None-Match still 304 (with or without Range)', async () => {
            const { handler, opened } = setupSpy();
            const first = await get(handler, 'pic.info/a.png', {}, 'HEAD');
            const etag = first.headers.get('ETag')!;
            for (const headers of [{ 'if-none-match': etag } as Record<string, string>, { 'if-none-match': etag, range: 'bytes=0-3' }]) {
                const res = await get(handler, 'pic.info/a.png', headers, 'HEAD');
                expect(res.status).toBe(304);
                expect(res.headers.get('Content-Range')).toBeNull();
                expect(await res.text()).toBe('');
            }
            expect(opened).toEqual([]);
        });

        test('authorization still applies to HEAD', async () => {
            const { handler, opened } = setupSpy();
            const res = await get(handler, 'locked.info/l.png', { range: 'bytes=0-1' }, 'HEAD');
            expect(res.status).toBe(404);
            expect(opened).toEqual([]);
        });
    });

    test('original ETag is strong, shared by 200 and 206, and matches with a weak echo', async () => {
        const handler = setup();
        const full = await get(handler, 'pic.info/a.png');
        await full.arrayBuffer();
        const part = await get(handler, 'pic.info/a.png', { range: 'bytes=0-3' });
        await part.arrayBuffer();
        const etag = part.headers.get('ETag')!;
        expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
        expect(full.headers.get('ETag')).toBe(etag);
        const weakEcho = await get(handler, 'pic.info/a.png', { 'if-none-match': `W/${etag}` });
        expect(weakEcho.status).toBe(304);
    });

    test('recovered original (stale name) goes through the same range path', async () => {
        const res = await get(setup(), 'pic.info/renamed.png', { range: 'bytes=-3' });
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 33-35/36');
        expect(await res.text()).toBe('xyz');
        const bad = await get(setup(), 'pic.info/renamed.png', { range: 'bytes=500-' });
        expect(bad.status).toBe(416);
        await bad.arrayBuffer();
    });

    test('extension case: .OGG serves audio/ogg', async () => {
        const res = await get(setup(), 'aud.info/a.OGG');
        expect(res.headers.get('Content-Type')).toBe('audio/ogg');
        await res.arrayBuffer();
    });

    test('SVG carries the sandbox CSP on 200 and 206', async () => {
        const handler = setup();
        for (const headers of [{} as Record<string, string>, { range: 'bytes=0-9' }]) {
            const res = await get(handler, 'vec.info/v.svg', headers);
            expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
            const csp = res.headers.get('Content-Security-Policy')!;
            expect(csp).toContain("default-src 'none'");
            expect(csp).toContain('sandbox');
            expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
            await res.arrayBuffer();
        }
    });

    test('304 wins over a Range request; validators are on 206', async () => {
        const handler = setup();
        const first = await get(handler, 'pic.info/a.png', { range: 'bytes=0-3' });
        const etag = first.headers.get('ETag')!;
        expect(etag).toBeTruthy();
        expect(first.headers.get('Last-Modified')).toBeTruthy();
        expect(first.headers.get('Cache-Control')).toBe('private, no-cache');
        await first.arrayBuffer();

        const cond = await get(handler, 'pic.info/a.png', { range: 'bytes=0-3', 'if-none-match': etag });
        expect(cond.status).toBe(304);
        expect(await cond.text()).toBe('');
    });

    test('authorization still precedes range handling', async () => {
        const handler = setup();
        const res = await get(handler, 'locked.info/l.png', { range: 'bytes=0-1' });
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('SE');
    });
});
