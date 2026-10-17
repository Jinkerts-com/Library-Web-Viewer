import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AccessDeps, AccessItem, LockState } from '../src/lib/itemAccess';
import { createOriginalHandler } from '../src/lib/mediaHandlers';
import { originalUrl } from '../src/lib/mediaUrls';
import { astroParams } from './helpers/astroRouting';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const items: Record<string, AccessItem> = {
    multi: { id: 'multi', name: 'photo', ext: 'png', folders: [] },
    odd: { id: 'odd', name: 'x', ext: 'png', folders: [] },
    vec: { id: 'vec', name: 'v', ext: 'svg', folders: [] },
    locked: { id: 'locked', name: 'l', ext: 'png', folders: ['L'] },
    cmp: { id: 'cmp', name: 'folder/actual', ext: 'png', folders: [] },
    bs: { id: 'bs', name: 'a"b\\c', ext: 'png', folders: [] },
    extra: { id: 'extra', name: 'real', ext: 'png', folders: [] },
    sym: { id: 'sym', name: 'link', ext: 'png', folders: [] },
};
const state: LockState = { ready: true, folders: [{ id: 'L', children: [] }], lockedFolderIds: new Set(['L']) };
const access: AccessDeps = { getLockState: () => state, lookupItem: id => items[id] ?? null };

// Several same-item originals whose names differ only by decode-sensitive characters
const MULTI = ['photo.png', 'photo copy.png', 'photo%20copy.png', 'photo#1.png', 'photo?x.png', 'photo+1.png', 'фото.png', 'a"b.png'];
// Backslash-containing name: a legal single filename on Linux, not creatable on Windows
const BACKSLASH_FILE = 'a"b\\c.png';

/** Can this filesystem hold a file with this exact name? (probed once, in a scratch dir) */
function creatable(name: string): boolean {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lwv-probe-'));
    try {
        fs.writeFileSync(path.join(d, name), 'x');
        return fs.readdirSync(d).includes(name);
    } catch {
        return false;
    } finally {
        fs.rmSync(d, { recursive: true, force: true });
    }
}

function symlinksSupported(): boolean {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lwv-probe-'));
    try {
        fs.writeFileSync(path.join(d, 't'), 'x');
        fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'));
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(d, { recursive: true, force: true });
    }
}

const CAN_QUOTE = creatable('a"b.png');
const CAN_BACKSLASH = creatable(BACKSLASH_FILE);
const CAN_SYMLINK = symlinksSupported();

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwv-orig-'));
    dirs.push(root);
    const lib = path.join(root, 'Library.library');
    const write = (id: string, name: string, data: string) => {
        const d = path.join(lib, 'images', `${id}.info`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, name), data);
    };
    for (const n of MULTI) {
        try { write('multi', n, `content-of:${n}`); } catch { /* names illegal on this OS are skipped */ }
    }
    write('odd', 'only.png', 'ONLY');
    write('vec', 'v.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    write('locked', 'l.png', 'SECRET');
    // Recovery fixture: a REAL file named like the recovery placeholder competes with the true original
    write('cmp', 'original.png', 'COMPETING');
    write('cmp', 'actual.png', 'ACTUAL');
    if (CAN_BACKSLASH) write('bs', BACKSLASH_FILE, 'BACKSLASH');
    write('extra', 'real.png', 'REAL');
    write('extra', 'metadata.json', '{"secret":true}');
    write('extra', 'x_thumbnail.png', 'THUMB');
    write('extra', 'other.png', 'OTHER');
    if (CAN_SYMLINK) {
        const outside = path.join(root, 'outside.png');
        fs.writeFileSync(outside, 'OUTSIDE');
        fs.mkdirSync(path.join(lib, 'images', 'sym.info'), { recursive: true });
        try { fs.symlinkSync(outside, path.join(lib, 'images', 'sym.info', 'link.png')); } catch { /* not permitted */ }
    }
    return createOriginalHandler({ access, getLibraryPath: () => lib });
}

/** Emulate the router for a client-built URL, then call the handler like Astro would. */
async function viaRouter(handler: ReturnType<typeof setup>, url: string, headers: Record<string, string> = {}, method = 'GET') {
    const u = new URL(url, 'http://app');
    const param = astroParams(u.pathname);
    if (param === 'ROUTER_400') return new Response('Bad', { status: 400 });
    return handler({ params: { path: param }, request: new Request(u, { method, headers }) } as any) as Promise<Response>;
}

describe('original route: reserved-character filenames end to end', () => {
    for (const n of MULTI) {
        const dot = n.lastIndexOf('.');
        test.skipIf(!creatable(n))(`serves exactly ${JSON.stringify(n)}`, async () => {
            const handler = setup();
            const res = await viaRouter(handler, originalUrl('multi', n.slice(0, dot), n.slice(dot + 1)));
            expect(res.status).toBe(200);
            expect(await res.text()).toBe(`content-of:${n}`);
        });
    }

    test('hand-built old-style URL with a plain encoded space still resolves', async () => {
        const res = await viaRouter(setup(), '/images/multi.info/photo%20copy.png');
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('content-of:photo copy.png');
    });

    test('old-style stale name still recovers to the sole original', async () => {
        const res = await viaRouter(setup(), '/images/odd.info/stale-name.png');
        expect(await res.text()).toBe('ONLY');
    });

    test('malformed escape is 400 and an unknown name among several is 409 (never a guess)', async () => {
        const h = setup();
        expect((await viaRouter(h, '/images/multi.info/%E0%A4%A.png')).status).toBe(400);
        expect((await viaRouter(h, '/images/multi.info/missing.png')).status).toBe(409);
    });
});

describe('original route: download requests', () => {
    test('attachment with a safe filename; bytes unchanged', async () => {
        const res = await viaRouter(setup(), originalUrl('multi', 'фото', 'png', undefined, { download: true }));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Disposition')).toBe(
            `attachment; filename="____.png"; filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE.png`);
        expect(await res.text()).toBe('content-of:фото.png');
    });

    test.skipIf(!CAN_QUOTE)('quote-only filename resolves and is sanitized in the header', async () => {
        const res = await viaRouter(setup(), originalUrl('multi', 'a"b', 'png', undefined, { download: true }));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('content-of:a"b.png');
        expect(res.headers.get('Content-Disposition')).toContain('filename="a_b.png"');
    });

    test.skipIf(!CAN_BACKSLASH)('backslash filename is unaddressable: sole original served via recovery, header sanitized', async () => {
        const res = await viaRouter(setup(), originalUrl('bs', 'a"b\\c', 'png', undefined, { download: true }));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('BACKSLASH');
        expect(res.headers.get('Content-Disposition')).toContain('filename="a_b_c.png"');
    });

    test('plain inline request has no Content-Disposition', async () => {
        const res = await viaRouter(setup(), originalUrl('multi', 'photo', 'png'));
        expect(res.headers.get('Content-Disposition')).toBeNull();
    });

    test('locked item download is the same 404 as any missing item', async () => {
        const h = setup();
        const locked = await viaRouter(h, originalUrl('locked', 'l', 'png', undefined, { download: true }));
        const missing = await viaRouter(h, originalUrl('nope', 'l', 'png', undefined, { download: true }));
        expect(locked.status).toBe(404);
        expect(await locked.text()).toBe(await missing.text());
        expect(locked.headers.get('Content-Disposition')).toBeNull();
    });

    test('a matching validator on a locked download does not bypass authorization', async () => {
        const h = setup();
        const res = await viaRouter(h, originalUrl('locked', 'l', 'png', undefined, { download: true }),
            { 'If-None-Match': '*', 'If-Modified-Since': new Date(Date.now() + 1e7).toUTCString() });
        expect(res.status).toBe(404);
    });

    test('conditional request on a download: 304 for the current validator', async () => {
        const h = setup();
        const url = originalUrl('odd', 'only', 'png', undefined, { download: true });
        const first = await viaRouter(h, url);
        const etag = first.headers.get('ETag')!;
        const second = await viaRouter(h, url, { 'If-None-Match': etag });
        expect(second.status).toBe(304);
    });

    test('Range works on a download and keeps the attachment disposition', async () => {
        const res = await viaRouter(setup(), originalUrl('odd', 'only', 'png', undefined, { download: true }), { Range: 'bytes=1-2' });
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Disposition')).toContain('attachment');
        expect(await res.text()).toBe('NL');
    });

    test('HEAD download carries the disposition without a body', async () => {
        const res = await viaRouter(setup(), originalUrl('odd', 'only', 'png', undefined, { download: true }), {}, 'HEAD');
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Disposition')).toContain('attachment');
    });
});

describe('original route: unaddressable names use explicit recovery', () => {
    test('competing original.png is NOT selected; several candidates -> 409', async () => {
        const h = setup();
        for (const name of ['folder/actual', 'folder\\actual']) {
            const res = await viaRouter(h, originalUrl('cmp', name, 'png'));
            expect(res.status).toBe(409);
            expect(await res.text()).not.toContain('COMPETING');
        }
    });

    test('same for downloads and with a literal %XX in the name', async () => {
        const h = setup();
        for (const name of ['folder/actual', 'folder/act%20ual']) {
            const res = await viaRouter(h, originalUrl('cmp', name, 'png', undefined, { download: true }));
            expect(res.status).toBe(409);
            expect(res.headers.get('Content-Disposition')).toBeNull();
        }
    });

    test('a plain request for original.png still gets exactly that file (exact match contract unchanged)', async () => {
        const res = await viaRouter(setup(), '/images/cmp.info/original.png');
        expect(await res.text()).toBe('COMPETING');
    });

    test('stale plain name among several is still 409 (not the competing file)', async () => {
        expect((await viaRouter(setup(), '/images/cmp.info/gone.png')).status).toBe(409);
    });

    test('recover=1 with a sole candidate serves it, ignoring the path segment', async () => {
        const res = await viaRouter(setup(), originalUrl('odd', 'dir/name', 'png'));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ONLY');
    });

    test('recover=1 ignores a matching exact name when several exist', async () => {
        const res = await viaRouter(setup(), '/images/multi.info/photo.png?recover=1');
        expect(res.status).toBe(409);
    });

    test('recover=1 stays behind authorization', async () => {
        const res = await viaRouter(setup(), originalUrl('locked', 'a/b', 'png'));
        expect(res.status).toBe(404);
    });
});

describe('original route: adversarial n= parameter', () => {
    const nReq = (item: string, n: string) => `/images/${item}.info/original.png?v=2&n=${encodeURIComponent(n)}`;

    test('separators and traversal in n are rejected (404, never served)', async () => {
        const h = setup();
        for (const n of ['../x.png', '..\\x.png', 'a/b.png', 'a\\b.png', '../../outside.png', '/etc/passwd', 'C:\\x.png']) {
            const res = await viaRouter(h, nReq('multi', n));
            expect([n, res.status]).toEqual([n, 404]);
        }
    });

    test('NUL in n is rejected', async () => {
        const res = await viaRouter(setup(), '/images/multi.info/original.png?n=a%00b.png');
        expect(res.status).toBe(404);
    });

    test('empty, dot and dot-dot n values are not honored', async () => {
        const h = setup();
        for (const n of ['', '.', '..']) {
            const res = await viaRouter(h, nReq('extra', n));
            expect([n, res.status]).toEqual([n, 404]);
        }
    });

    test('auxiliary files are never served through n', async () => {
        const h = setup();
        for (const n of ['metadata.json', 'METADATA.JSON', 'x_thumbnail.png', 'X_THUMBNAIL.PNG']) {
            const res = await viaRouter(h, nReq('extra', n));
            expect(res.status).toBe(404);
            const body = await res.text();
            expect(body).not.toContain('secret');
            expect(body).not.toContain('THUMB');
        }
    });

    test('a valid n still wins over the path segment', async () => {
        const res = await viaRouter(setup(), nReq('extra', 'other.png'));
        expect(await res.text()).toBe('OTHER');
    });

    test.skipIf(!CAN_SYMLINK)('n naming an escaping symlink never serves the outside file', async () => {
        const h = setup();
        expect(fs.lstatSync(path.join(dirs[0], 'Library.library', 'images', 'sym.info', 'link.png')).isSymbolicLink()).toBe(true);
        const res = await viaRouter(h, nReq('sym', 'link.png'));
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('OUTSIDE');
    });
});

describe('original route: active formats', () => {
    test('SVG is always an attachment (plus the sandbox CSP), even without download=1', async () => {
        const res = await viaRouter(setup(), originalUrl('vec', 'v', 'svg'));
        expect(res.headers.get('Content-Disposition')).toContain('attachment');
        expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
        expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    });
});
