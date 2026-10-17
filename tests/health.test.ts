import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHealthHandler } from '../src/lib/health';

const dirs: string[] = [];
const dbs: Database[] = [];
function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
    dirs.push(d);
    return d;
}
afterEach(() => {
    for (const d of dbs.splice(0)) { try { d.close(); } catch { } }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function handler(libraryPath: string, probe: () => void = () => { }, logs: string[] = []) {
    return createHealthHandler({ getLibraryPath: () => libraryPath, probeDatabase: probe, log: (m) => logs.push(m) });
}

// The deployed probe is a dependency-free `bun -e` one-liner (the slim image has no curl). Tests
// extract that exact script from the Dockerfile, require compose/README to carry the identical
// string, and execute it against a fake fetch/process to observe the URL it builds.
const root = path.join(import.meta.dir, '..');
function readRoot(f: string): string { return fs.readFileSync(path.join(root, f), 'utf8'); }
const probeScript: string = (() => {
    const m = readRoot('dockerfile').match(/^\s*CMD (\["bun", "-e", .*\])\s*$/m);
    return JSON.parse(m![1])[2];
})();

async function probe(env: Record<string, string>, status = 200): Promise<{ url: string; exit: number }> {
    let url = '';
    let resolveExit!: (n: number) => void;
    const exited = new Promise<number>((r) => { resolveExit = r; });
    const fakeFetch = (u: string) => { url = u; return Promise.resolve({ status, ok: status >= 200 && status < 300 }); };
    new Function('process', 'fetch', 'AbortSignal', probeScript)(
        { env, exit: (n: number) => resolveExit(n) }, fakeFetch, AbortSignal);
    return { url, exit: await exited };
}

describe('healthcheck probe command', () => {
    test('Dockerfile, compose and README carry the identical probe', () => {
        expect(readRoot('docker-compose.yaml')).toContain(JSON.stringify(probeScript));
        expect(readRoot('README.md')).toContain(JSON.stringify(probeScript));
    });

    const cases: [string, Record<string, string>, string][] = [
        ['unset HOST', {}, 'http://127.0.0.1:4321/api/health'],
        ['IPv4 wildcard', { HOST: '0.0.0.0', PORT: '8080' }, 'http://127.0.0.1:8080/api/health'],
        ['IPv4 literal', { HOST: '192.168.1.50' }, 'http://192.168.1.50:4321/api/health'],
        ['hostname', { HOST: 'library.local' }, 'http://library.local:4321/api/health'],
        ['IPv6 wildcard', { HOST: '::' }, 'http://[::1]:4321/api/health'],
        ['IPv6 loopback', { HOST: '::1' }, 'http://[::1]:4321/api/health'],
        ['general IPv6 literal', { HOST: '2001:db8::1', PORT: '9000' }, 'http://[2001:db8::1]:9000/api/health'],
        ['already-bracketed IPv6', { HOST: '[::1]' }, 'http://[::1]:4321/api/health']
    ];
    for (const [name, env, expected] of cases) {
        test(`${name} -> ${expected}`, async () => {
            const { url } = await probe(env);
            expect(url).toBe(expected);
            expect(() => new URL(url)).not.toThrow();
        });
    }

    test('only HTTP 200 is healthy (other 2xx and 503 are not)', async () => {
        expect((await probe({}, 200)).exit).toBe(0);
        expect((await probe({}, 204)).exit).toBe(1);
        expect((await probe({}, 503)).exit).toBe(1);
    });
});

describe('health endpoint', () => {
    test('healthy library and database -> 200 with minimal stable body and sane headers', async () => {
        const lib = tmp();
        fs.mkdirSync(path.join(lib, 'images'));
        const res = handler(lib)();
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/json');
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(await res.json()).toEqual({ status: 'ok', checks: { library: 'ok', database: 'ok' } });
    });

    test('empty library directory is healthy', async () => {
        const res = handler(tmp())();
        expect(res.status).toBe(200);
        expect((await res.json() as any).status).toBe('ok');
    });

    test('does not write to or create anything in the library', () => {
        const lib = tmp();
        handler(lib)();
        handler(lib)();
        expect(fs.readdirSync(lib)).toEqual([]);
    });

    test('missing library path -> 503 with no absolute path in body', async () => {
        const missing = path.join(tmp(), 'does-not-exist-xyz');
        const logs: string[] = [];
        const res = handler(missing, () => { }, logs)();
        expect(res.status).toBe(503);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ status: 'unavailable', checks: { library: 'unavailable', database: 'ok' } });
        expect(text).not.toContain('does-not-exist-xyz');
        expect(text).not.toContain(os.tmpdir());
        expect(text).not.toMatch(/[A-Za-z]:\\|\/tmp|\/var/);
        // the detail (with the path) goes to the server log only
        expect(logs.join('\n')).toContain('does-not-exist-xyz');
    });

    test('library path that is a file -> 503', async () => {
        const f = path.join(tmp(), 'file.txt');
        fs.writeFileSync(f, 'x');
        const res = handler(f)();
        expect(res.status).toBe(503);
        expect(await res.text()).not.toContain('file.txt');
    });

    test('library path not configured -> 503 not_configured', async () => {
        const res = handler('')();
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ status: 'unavailable', checks: { library: 'not_configured', database: 'ok' } });
    });

    test('database failure -> 503, sanitized (error text only in log)', async () => {
        const logs: string[] = [];
        const secret = path.join(tmp(), 'secret-db-dir', 'library.db');
        const res = handler(tmp(), () => { throw new Error(`unable to open ${secret}`); }, logs)();
        expect(res.status).toBe(503);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ status: 'unavailable', checks: { library: 'ok', database: 'unavailable' } });
        expect(text).not.toContain('secret-db-dir');
        expect(logs.join('\n')).toContain('secret-db-dir');
    });

    test('closed real database handle -> 503', () => {
        const db = new Database(':memory:');
        const h = handler(tmp(), () => { db.query('SELECT 1').get(); });
        expect(h().status).toBe(200);
        db.close();
        expect(h().status).toBe(503);
    });

    test('stays healthy while a scan-like write transaction is open (scanning is not unhealthy)', () => {
        const file = path.join(tmp(), 'scan.db');
        const writer = new Database(file, { create: true });
        dbs.push(writer);
        writer.run('PRAGMA journal_mode = WAL;');
        writer.run('CREATE TABLE items (id TEXT)');
        const reader = new Database(file);
        dbs.push(reader);
        writer.run('BEGIN IMMEDIATE');
        writer.run("INSERT INTO items VALUES ('a')");
        const res = handler(tmp(), () => { reader.query('SELECT 1').get(); })();
        writer.run('ROLLBACK');
        expect(res.status).toBe(200);
    });

    test('logs a failure once per distinct state, and recovery once', () => {
        const logs: string[] = [];
        let fail = true;
        const h = handler(tmp(), () => { if (fail) throw new Error('boom'); }, logs);
        h(); h(); h();
        expect(logs.length).toBe(1);
        fail = false;
        h(); h();
        expect(logs.length).toBe(2);
        expect(logs[1]).toContain('Recovered');
    });

    test('a throwing logger never changes the response', () => {
        const h = createHealthHandler({
            getLibraryPath: () => '',
            probeDatabase: () => { },
            log: () => { throw new Error('closed pipe'); }
        });
        expect(h().status).toBe(503);
    });
});
