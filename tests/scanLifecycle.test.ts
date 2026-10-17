import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import {
    EXIT_CODES, SANITIZED_MESSAGES, createScanHandler, createScanService, exitCodeForResult,
    runCleanupSteps, runThumbnailCommand, safeEmit, type LibraryScanResult, type ScanFailureReason
} from '../src/lib/scanLifecycle';
import sharp from 'sharp';
import { DB_FILES, SERVER_MUST_BE_STOPPED, removeDatabaseFiles } from '../src/lib/rebuildGuard';
import { createLibraryFixture, type LibraryFixture } from './helpers/libraryFixture';

let fx: LibraryFixture;

beforeEach(() => { fx = createLibraryFixture(); });
afterEach(() => { fx.cleanup(); });

function makeService(overrides: { libraryPath?: string; indexer?: any } = {}) {
    const emitter = new EventEmitter();
    const completes: any[] = [];
    emitter.on('complete', (d) => completes.push(d));
    const indexer = overrides.indexer ?? fx.createIndexer();
    const service = createScanService({
        indexer,
        getLibraryPath: () => overrides.libraryPath ?? fx.libraryPath,
        emitter
    });
    return { service, emitter, completes, indexer };
}

/** Failure outcomes must be definite, sanitized and visible to status readers. */
function expectTerminalFailure(r: LibraryScanResult, reason: ScanFailureReason, ctx: ReturnType<typeof makeService>) {
    expect(r.outcome).toBe('failure');
    if (r.outcome !== 'failure') throw new Error("unreachable");
    expect(r.reason).toBe(reason);
    expect(r.error).toBe(SANITIZED_MESSAGES[reason]);
    expect(JSON.stringify(r)).not.toContain(fx.root);

    const status = ctx.service.getScanStatus();
    expect(status.isScanning).toBe(false);
    expect(status.status).toBe('idle');
    expect(status.outcome).toBe('failure');
    expect(status.error).toBe(r.error);

    expect(ctx.completes).toHaveLength(1);
    expect(ctx.completes[0]).toMatchObject({ isScanning: false, outcome: 'failure', error: r.error });
    expect(exitCodeForResult(r)).toBe(EXIT_CODES.FAILURE);
}

describe("terminal outcomes", () => {
    test("missing images directory -> failure, rows untouched", async () => {
        fx.seedRow("KEEP");
        fs.rmSync(fx.imagesDir, { recursive: true, force: true });
        const ctx = makeService();

        expectTerminalFailure(await ctx.service.performLibraryScan(), 'images_unavailable', ctx);
        expect(fx.rowIds()).toEqual(["KEEP"]);
    });

    test("images path that is a file (unreadable) -> failure", async () => {
        fs.rmSync(fx.imagesDir, { recursive: true, force: true });
        fs.writeFileSync(fx.imagesDir, "not a directory");
        const ctx = makeService();

        expectTerminalFailure(await ctx.service.performLibraryScan(), 'images_unavailable', ctx);
    });

    test("malformed library metadata.json -> failure, no cleanup", async () => {
        fx.seedRow("KEEP");
        fx.writeItem("A");
        fs.writeFileSync(path.join(fx.libraryPath, "metadata.json"), "{ not json");
        const ctx = makeService();

        expectTerminalFailure(await ctx.service.performLibraryScan(), 'library_metadata_invalid', ctx);
        expect(fx.rowIds()).toEqual(["KEEP"]);
    });

    test("library metadata.json that is valid JSON but not an object -> failure", async () => {
        fs.writeFileSync(path.join(fx.libraryPath, "metadata.json"), "[]");
        const ctx = makeService();

        expectTerminalFailure(await ctx.service.performLibraryScan(), 'library_metadata_invalid', ctx);
    });

    test("empty library is a success, not a failure", async () => {
        fx.writeRootMetadata();
        const ctx = makeService();

        const r = await ctx.service.performLibraryScan();

        expect(r).toMatchObject({ outcome: 'success', total: 0, scanned: 0, failedItems: 0 });
        expect(exitCodeForResult(r)).toBe(EXIT_CODES.SUCCESS);
        expect(ctx.service.getScanStatus()).toMatchObject({ isScanning: false, outcome: 'success', error: null });
        expect(ctx.completes).toHaveLength(1);
    });

    test("unreadable item -> partial with sanitized count-only summary", async () => {
        fx.writeItem("GOODONE");
        fs.mkdirSync(path.join(fx.imagesDir, "SECRETID123.info", "metadata.json"), { recursive: true });
        const ctx = makeService();

        const r = await ctx.service.performLibraryScan();

        expect(r.outcome).toBe('partial');
        expect(r).toMatchObject({ total: 2, upserts: 1, failedItems: 1 });
        expect(JSON.stringify(r)).not.toContain("SECRETID123");
        expect(exitCodeForResult(r)).toBe(EXIT_CODES.PARTIAL);
        expect(ctx.service.getScanStatus()).toMatchObject({ outcome: 'partial', failedItems: 1, isScanning: false });
        expect(ctx.completes[0]).toMatchObject({ isScanning: false, outcome: 'partial' });
    });

    test("genuine success reports counts", async () => {
        fx.writeItem("A");
        fx.writeItem("B");
        const ctx = makeService();

        const r = await ctx.service.performLibraryScan();

        expect(r).toMatchObject({ outcome: 'success', total: 2, upserts: 2, skipped: 0, removed: 0, failedItems: 0 });
        expect(ctx.service.getScanStatus()).toMatchObject({ outcome: 'success', error: null, scannedCount: 2 });
    });

    test("an exception thrown by the indexer -> failure with a terminal non-scanning status", async () => {
        const indexer = {
            isScanning: false, scannedCount: 0,
            scan: async () => { throw new Error(`boom at ${fx.root}`); }
        };
        const ctx = makeService({ indexer });

        expectTerminalFailure(await ctx.service.performLibraryScan(), 'internal', ctx);
    });

    test("an internal failure (batch error) is sanitized", async () => {
        fx.writeItem("A");
        const ctx = makeService({ indexer: fx.createIndexer({ invalidateCache: () => { throw new Error(`secret ${fx.root}`); } }) });

        expectTerminalFailure(await ctx.service.performLibraryScan(), 'internal', ctx);
    });

    test("missing LIBRARY_PATH -> definite not_configured failure, not undefined", async () => {
        const ctx = makeService({ libraryPath: "" });

        const started = ctx.service.startLibraryScan();
        expect(started.kind).toBe('unconfigured');

        const r = await ctx.service.performLibraryScan();
        expect(r).toMatchObject({ outcome: 'failure', reason: 'not_configured' });
        expect(ctx.service.getScanStatus()).toMatchObject({ isScanning: false, outcome: 'failure' });
        expect(ctx.completes.length).toBeGreaterThanOrEqual(1);
    });
});

describe("events", () => {
    test("a throwing 'complete' listener cannot break the scan, and 'error' is never emitted", async () => {
        fx.writeItem("A");
        const emitter = new EventEmitter();
        emitter.on('complete', () => { throw new Error("listener exploded"); });
        const service = createScanService({ indexer: fx.createIndexer(), getLibraryPath: () => fx.libraryPath, emitter });

        const r = await service.performLibraryScan();

        expect(r.outcome).toBe('success');
        expect(service.getScanStatus().isScanning).toBe(false);
        expect(() => safeEmit(new EventEmitter(), 'error', new Error("x"))).toThrow(/reserved/);
    });

    test("a late SSE-style subscriber still reads the terminal state from getScanStatus", async () => {
        fs.rmSync(fx.imagesDir, { recursive: true, force: true });
        const ctx = makeService();
        await ctx.service.performLibraryScan();

        const snapshot = ctx.service.getScanStatus();
        expect(snapshot).toMatchObject({ isScanning: false, status: 'idle', outcome: 'failure' });
        expect(typeof snapshot.scannedCount).toBe('number');
    });
});

describe("concurrency", () => {
    function gatedService() {
        fx.writeItem("A");
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let readdirCalls = 0;
        const indexer = fx.createIndexer({
            fs: { readdir: async (p) => { readdirCalls++; await gate; return fs.promises.readdir(p); } }
        });
        return { ...makeService({ indexer }), release, readdirCalls: () => readdirCalls };
    }

    test("performLibraryScan: simultaneous calls run one scan, the other reports busy", async () => {
        const g = gatedService();

        const first = g.service.performLibraryScan();
        const second = await g.service.performLibraryScan();
        expect(second.outcome).toBe('busy');
        expect(exitCodeForResult(second)).toBe(EXIT_CODES.FAILURE);
        expect(g.service.getScanStatus().isScanning).toBe(true);

        g.release();
        expect((await first).outcome).toBe('success');
        expect(g.readdirCalls()).toBe(1);
        // busy is not a scan: it published nothing and did not alter the recorded outcome
        expect(g.completes).toHaveLength(1);
        expect(g.service.getScanStatus().outcome).toBe('success');
    });

    test("API level: first POST accepted, concurrent POST busy (409), later POST accepted again", async () => {
        const g = gatedService();
        const post = createScanHandler(g.service.startLibraryScan, { info() { }, error() { } });

        const a = await post();
        const b = await post();
        expect(a.status).toBe(200);
        expect(await a.json()).toEqual({ message: "Scan started", status: 'accepted' });
        expect(b.status).toBe(409);
        expect(await b.json()).toMatchObject({ status: 'busy' });

        g.release();
        await waitUntil(() => !g.service.getScanStatus().isScanning, "scan to finish");
        const c = await post();
        expect(c.status).toBe(200);
        await waitUntil(() => g.completes.length === 2, "second scan to finish");
        expect(g.readdirCalls()).toBe(2);
    });
});

describe("service-level ownership (acceptance -> terminal publication)", () => {
    test("a start scheduled after indexer release but before the service continuation cannot overtake publication", async () => {
        fx.writeItem("A");
        const ctx = (() => {
            const emitter = new EventEmitter();
            const completes: any[] = [];
            emitter.on('complete', (d) => completes.push(d));
            let service!: ReturnType<typeof createScanService>;
            const racing: { indexerWasReleased?: boolean; second?: ReturnType<typeof service.startLibraryScan> } = {};
            // onIndexChanged runs after the indexer released isScanning, before its promise resolves
            const indexer = fx.createIndexer({
                onIndexChanged: () => queueMicrotask(() => {
                    racing.indexerWasReleased = !indexer.isScanning;
                    racing.second = service.startLibraryScan();
                })
            });
            service = createScanService({ indexer, getLibraryPath: () => fx.libraryPath, emitter });
            return { service, completes, racing, indexer };
        })();

        const r = await ctx.service.performLibraryScan();

        expect(r.outcome).toBe('success');
        expect(ctx.racing.indexerWasReleased).toBe(true); // the window really was open
        expect(ctx.racing.second?.kind).toBe('busy'); // ...and the second start could not overtake
        expect(ctx.completes).toHaveLength(1);
        expect(ctx.completes[0]).toMatchObject({ isScanning: false, status: 'idle', outcome: 'success' });
        expect(ctx.service.getScanStatus()).toMatchObject({ isScanning: false, status: 'idle', outcome: 'success' });
        expect(ctx.service.getScanStatus().scannedCount).toBe(ctx.completes[0].scannedCount);

        // ownership ends with publication: the next start is admitted
        expect(ctx.service.startLibraryScan().kind).toBe('accepted');
    });

    test("status reports scanning during the release window (a running scan is not hidden from SSE readers)", async () => {
        fx.writeItem("A");
        let seen: any;
        let service!: ReturnType<typeof createScanService>;
        const indexer = fx.createIndexer({ onIndexChanged: () => queueMicrotask(() => { seen = service.getScanStatus(); }) });
        service = createScanService({ indexer, getLibraryPath: () => fx.libraryPath, emitter: new EventEmitter() });

        await service.performLibraryScan();

        expect(seen).toMatchObject({ isScanning: true, status: 'scanning' });
        expect(service.getScanStatus().isScanning).toBe(false);
    });
});

describe("nonthrowing logger at lifecycle boundaries", () => {
    const thrower = {
        info() { throw new Error("logger info exploded"); },
        error() { throw new Error("logger error exploded"); }
    };
    let unhandled: unknown[];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    beforeEach(() => { unhandled = []; process.on('unhandledRejection', onUnhandled); });
    afterEach(() => { process.off('unhandledRejection', onUnhandled); });

    function throwingService(overrides: { libraryPath?: string; indexer?: any } = {}) {
        const emitter = new EventEmitter();
        const completes: any[] = [];
        emitter.on('complete', (d) => completes.push(d));
        const service = createScanService({
            indexer: overrides.indexer ?? fx.createIndexer(),
            getLibraryPath: () => overrides.libraryPath ?? fx.libraryPath,
            emitter,
            logger: thrower
        });
        return { service, completes };
    }

    const settle = () => new Promise((r) => setTimeout(r, 20));

    test("(a) unconfigured library: definite sanitized failure and terminal publication", async () => {
        const ctx = throwingService({ libraryPath: "" });

        const r = await ctx.service.performLibraryScan();

        expect(r).toMatchObject({ outcome: 'failure', reason: 'not_configured', error: SANITIZED_MESSAGES.not_configured });
        expect(ctx.completes).toHaveLength(1);
        expect(ctx.completes[0]).toMatchObject({ isScanning: false, outcome: 'failure' });
        expect(ctx.service.getScanStatus()).toMatchObject({ isScanning: false, outcome: 'failure' });
    });

    test("(b) failed result: resolves with a sanitized failure and publishes it", async () => {
        fs.rmSync(fx.imagesDir, { recursive: true, force: true });
        const ctx = throwingService();

        const started = ctx.service.startLibraryScan();
        expect(started.kind).toBe('accepted');
        const r = await (started as any).done;

        expect(r).toMatchObject({ outcome: 'failure', reason: 'images_unavailable', error: SANITIZED_MESSAGES.images_unavailable });
        expect(JSON.stringify(r)).not.toContain(fx.root);
        expect(ctx.completes).toHaveLength(1);
        expect(ctx.service.getScanStatus()).toMatchObject({ isScanning: false, outcome: 'failure' });
    });

    test("(c) unexpected indexer error: done resolves (never rejects) and the terminal state is published", async () => {
        const indexer = { isScanning: false, scannedCount: 0, scan: async () => { throw new Error(`boom ${fx.root}`); } };
        const ctx = throwingService({ indexer });

        const r = await ctx.service.performLibraryScan();

        expect(r).toMatchObject({ outcome: 'failure', reason: 'internal', error: SANITIZED_MESSAGES.internal });
        expect(ctx.completes).toHaveLength(1);
        expect(ctx.service.getScanStatus()).toMatchObject({ isScanning: false, outcome: 'failure' });
        await settle();
        expect(unhandled).toEqual([]);
    });

    test("(d) API error path: generic sanitized 500; accepted request has no unhandled rejection", async () => {
        const res = await createScanHandler(() => { throw new Error("EPERM C:\\secret\\library"); }, thrower)();
        const text = await res.text();
        expect(res.status).toBe(500);
        expect(JSON.parse(text)).toEqual({ error: "Failed to start the scan." });
        expect(text).not.toContain("secret");

        // a throwing info() must not stop an accepted scan either
        fx.writeItem("A");
        const ctx = throwingService();
        const ok = await createScanHandler(ctx.service.startLibraryScan, thrower)();
        expect(ok.status).toBe(200);
        expect((await ok.json()).message).toBe("Scan started");
        await waitUntil(() => ctx.completes.length === 1, "accepted scan to publish");
        await settle();
        expect(unhandled).toEqual([]);

        // even a (contract-violating) rejecting done promise cannot leak
        const rejecting = await createScanHandler(() => ({ kind: 'accepted', done: Promise.reject(new Error("x")) }), thrower)();
        expect(rejecting.status).toBe(200);
        await settle();
        expect(unhandled).toEqual([]);
    });

    test("cleanup keeps closing remaining resources when a close fails and reporting throws", async () => {
        const closed: string[] = [];
        await runCleanupSteps([
            ["one", () => { closed.push("one"); throw new Error("close failed"); }],
            ["two", async () => { closed.push("two"); throw new Error("close failed"); }],
            ["three", () => { closed.push("three"); }]
        ], thrower);

        expect(closed).toEqual(["one", "two", "three"]);
    });

    test("a throwing listener does not starve later listeners of the terminal event", async () => {
        fx.writeItem("A");
        const emitter = new EventEmitter();
        const got: any[] = [];
        emitter.on('complete', () => { throw new Error("first listener exploded"); });
        emitter.on('complete', (d) => got.push(d));
        const service = createScanService({ indexer: fx.createIndexer(), getLibraryPath: () => fx.libraryPath, emitter });

        await service.performLibraryScan();

        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ isScanning: false, outcome: 'success' });
    });
});

describe("terminal publication: admission guard and containment", () => {
    function countingIndexer() {
        const real = fx.createIndexer();
        const counter = { scans: 0 };
        const indexer = {
            get isScanning() { return real.isScanning; },
            get scannedCount() { return real.scannedCount; },
            scan: () => { counter.scans++; return real.scan(); }
        };
        return { indexer, counter };
    }

    test("starts from a synchronous terminal listener are busy while status/event agree for every listener", async () => {
        fx.writeItem("A");
        const { indexer, counter } = countingIndexer();
        const emitter = new EventEmitter();
        const service = createScanService({ indexer, getLibraryPath: () => fx.libraryPath, emitter });
        const attempts: { start?: any; perform?: Promise<LibraryScanResult> } = {};
        const seen: { event: any; status: any }[] = [];
        // FIRST listener tries both start APIs; LATER listeners compare payload with an immediate status read
        emitter.on('complete', () => {
            attempts.start = service.startLibraryScan();
            attempts.perform = service.performLibraryScan();
        });
        emitter.on('complete', (d) => seen.push({ event: d, status: service.getScanStatus() }));
        emitter.on('complete', (d) => seen.push({ event: d, status: service.getScanStatus() }));

        const r = await service.performLibraryScan();

        expect(r.outcome).toBe('success');
        expect(attempts.start).toEqual({ kind: 'busy' });
        expect('done' in attempts.start).toBe(false);
        expect(await attempts.perform).toMatchObject({ outcome: 'busy' });
        expect(counter.scans).toBe(1); // nothing else started
        expect(seen).toHaveLength(2); // and nothing else published
        for (const { event, status } of seen) {
            expect(event.isScanning).toBe(false);
            expect(status.isScanning).toBe(false);
            expect(status.status).toBe('idle');
            expect(event).toMatchObject({ isScanning: status.isScanning, status: status.status, outcome: status.outcome, finishedAt: status.finishedAt });
        }

        // the guard is released once publication completes
        const after = service.startLibraryScan();
        expect(after.kind).toBe('accepted');
        await (after as any).done;
        expect(counter.scans).toBe(2);
    });

    test("a publication-infrastructure failure is contained: done resolves, record kept, guards released", async () => {
        fx.writeItem("A");
        const { indexer } = countingIndexer();
        const emitter = new EventEmitter();
        const reported: unknown[] = [];
        const service = createScanService({
            indexer, getLibraryPath: () => fx.libraryPath, emitter,
            logger: { info() { }, error: (...a: unknown[]) => { reported.push(a); } }
        });
        const realRaw = emitter.rawListeners.bind(emitter);
        let failing = true;
        emitter.rawListeners = ((e: string) => {
            if (failing) throw new Error("injected publication failure");
            return realRaw(e);
        }) as typeof emitter.rawListeners;

        const started = service.startLibraryScan();
        expect(started.kind).toBe('accepted');
        const r = await (started as any).done; // must resolve, not reject

        expect(r.outcome).toBe('success');
        expect(reported.map((a) => String((a as any[])[1]))).toEqual(["Error: injected publication failure"]);
        expect(service.getScanStatus()).toMatchObject({ isScanning: false, status: 'idle', outcome: 'success' });
        expect(service.getScanStatus().finishedAt).not.toBeNull();

        failing = false;
        const next = service.startLibraryScan(); // ownership and admission guard released
        expect(next.kind).toBe('accepted');
        await (next as any).done;
    });

    test("unconfigured terminal listener calling both start APIs is busy; one event; later listeners agree with status", async () => {
        const { indexer, counter } = countingIndexer();
        const emitter = new EventEmitter();
        const service = createScanService({ indexer, getLibraryPath: () => "", emitter });
        const attempts: { start?: any; perform?: Promise<LibraryScanResult> } = {};
        const seen: { event: any; status: any }[] = [];
        let events = 0;
        emitter.on('complete', () => {
            events++;
            attempts.start = service.startLibraryScan();
            attempts.perform = service.performLibraryScan();
        });
        emitter.on('complete', (d) => seen.push({ event: d, status: service.getScanStatus() }));

        const started = service.startLibraryScan();

        expect(started.kind).toBe('unconfigured');
        expect(attempts.start).toEqual({ kind: 'busy' });
        expect('done' in attempts.start).toBe(false);
        expect(await attempts.perform).toMatchObject({ outcome: 'busy' });
        expect(events).toBe(1);
        expect(counter.scans).toBe(0);
        expect(seen).toHaveLength(1);
        expect(seen[0].event).toMatchObject({ isScanning: false, status: 'idle', outcome: 'failure', finishedAt: seen[0].status.finishedAt });
        expect(seen[0].status).toMatchObject({ isScanning: false, status: 'idle', outcome: 'failure' });
    });

    test("an unconditionally retrying unconfigured listener does not recurse", () => {
        const emitter = new EventEmitter();
        const service = createScanService({ indexer: countingIndexer().indexer, getLibraryPath: () => "", emitter });
        let events = 0;
        emitter.on('complete', () => { events++; service.startLibraryScan(); });
        expect(service.startLibraryScan().kind).toBe('unconfigured');
        expect(events).toBe(1);
    });

    test("after an unconfigured publication the guard is released and the next call publishes normally", () => {
        const emitter = new EventEmitter();
        const service = createScanService({ indexer: countingIndexer().indexer, getLibraryPath: () => "", emitter });
        let events = 0;
        emitter.on('complete', () => { events++; });
        const first = service.startLibraryScan();
        const second = service.startLibraryScan();
        expect(first.kind).toBe('unconfigured');
        expect(second.kind).toBe('unconfigured');
        expect(events).toBe(2);
        expect(service.getScanStatus()).toMatchObject({ isScanning: false, outcome: 'failure' });
    });

    test("throwing publication infrastructure on the unconfigured path: guard released, record retained", () => {
        const emitter = new EventEmitter();
        const reported: unknown[] = [];
        const service = createScanService({
            indexer: countingIndexer().indexer, getLibraryPath: () => "", emitter,
            logger: { info() { }, error: (...a: unknown[]) => { reported.push(a); } }
        });
        const realRaw = emitter.rawListeners.bind(emitter);
        let failing = true;
        emitter.rawListeners = ((e: string) => {
            if (failing) throw new Error("injected publication failure");
            return realRaw(e);
        }) as typeof emitter.rawListeners;

        const first = service.startLibraryScan();
        expect(first.kind).toBe('unconfigured');
        expect(service.getScanStatus()).toMatchObject({ isScanning: false, outcome: 'failure' });
        expect(service.getScanStatus().finishedAt).not.toBeNull();
        expect(reported.some((a) => String((a as any[])[1]) === "Error: injected publication failure")).toBe(true);

        failing = false;
        let events = 0;
        emitter.on('complete', () => { events++; });
        expect(service.startLibraryScan().kind).toBe('unconfigured'); // not stuck busy
        expect(events).toBe(1);
    });

    test("configuration becoming empty during an existing publication does not bypass admission protection", async () => {
        fx.writeItem("A");
        const { indexer, counter } = countingIndexer();
        const emitter = new EventEmitter();
        let path = fx.libraryPath;
        const service = createScanService({ indexer, getLibraryPath: () => path, emitter });
        const attempts: any[] = [];
        let events = 0;
        emitter.on('complete', () => {
            events++;
            path = "";
            attempts.push(service.startLibraryScan());
        });

        const r = await service.performLibraryScan();

        expect(r.outcome).toBe('success');
        expect(attempts).toEqual([{ kind: 'busy' }]);
        expect(events).toBe(1);
        expect(counter.scans).toBe(1);
        expect(service.getScanStatus().outcome).toBe('success'); // record not replaced by a nested not_configured
    });

    test("an accepted scan whose indexer reports busy releases ownership without recording or publishing", async () => {
        fx.writeItem("A");
        const real = fx.createIndexer();
        let busyNext = false;
        const indexer = {
            get isScanning() { return real.isScanning; },
            get scannedCount() { return real.scannedCount; },
            scan: () => busyNext
                ? Promise.resolve({ status: 'busy', total: 0, scanned: 0, upserts: 0, skipped: 0, removed: 0, failures: [] } as any)
                : real.scan()
        };
        const emitter = new EventEmitter();
        const service = createScanService({ indexer, getLibraryPath: () => fx.libraryPath, emitter });
        expect((await service.performLibraryScan()).outcome).toBe('success');
        const before = service.getScanStatus();
        let events = 0;
        emitter.on('complete', () => { events++; });

        busyNext = true;
        const started = service.startLibraryScan();
        expect(started.kind).toBe('accepted');
        expect(await (started as any).done).toMatchObject({ outcome: 'busy' });

        expect(events).toBe(0);
        expect(service.getScanStatus()).toEqual(before); // idle and the previous terminal record unchanged
        busyNext = false;
        const again = service.startLibraryScan();
        expect(again.kind).toBe('accepted'); // not stuck busy
        expect((await (again as any).done).outcome).toBe('success');
        expect(events).toBe(1);
    });
});

describe("runThumbnailCommand (unit, injected)", () => {
    const quiet = { info() { }, error() { } };
    function run(over: Partial<Parameters<typeof runThumbnailCommand>[0]>) {
        const cleanup = { calls: 0 };
        return {
            cleanup,
            promise: runThumbnailCommand({
                libraryPath: "/lib", listItems: () => [], generate: async () => null,
                cleanup: async () => { cleanup.calls++; }, log: quiet, ...over
            })
        };
    }

    test("empty library -> 0, cleanup ran", async () => {
        const r = run({});
        expect(await r.promise).toBe(EXIT_CODES.SUCCESS);
        expect(r.cleanup.calls).toBe(1);
    });

    test("generated and legitimately skipped (null) items -> 0", async () => {
        const r = run({ listItems: () => [{ id: "A" }, { id: "B" }], generate: async (id) => id === "A" ? Buffer.from("x") : null });
        expect(await r.promise).toBe(EXIT_CODES.SUCCESS);
        expect(r.cleanup.calls).toBe(1);
    });

    test("missing configuration -> 1, nothing enumerated, cleanup ran", async () => {
        let listed = false;
        const r = run({ libraryPath: "", listItems: () => { listed = true; return []; } });
        expect(await r.promise).toBe(EXIT_CODES.FAILURE);
        expect(listed).toBe(false);
        expect(r.cleanup.calls).toBe(1);
    });

    test("enumeration failure -> 1, cleanup ran", async () => {
        const r = run({ listItems: () => { throw new Error("no such table: items"); } });
        expect(await r.promise).toBe(EXIT_CODES.FAILURE);
        expect(r.cleanup.calls).toBe(1);
    });

    test("caught item errors -> 2, other items still processed, cleanup ran", async () => {
        const seen: string[] = [];
        const r = run({
            listItems: () => [{ id: "A" }, { id: "BAD" }, { id: "C" }],
            generate: async (id) => { seen.push(id); if (id === "BAD") throw new Error("boom"); return Buffer.from("x"); }
        });
        expect(await r.promise).toBe(EXIT_CODES.PARTIAL);
        expect(seen.sort()).toEqual(["A", "BAD", "C"]);
        expect(r.cleanup.calls).toBe(1);
    });

    test("throwing logger and failing cleanup still yield a definite code", async () => {
        const thrower = { info() { throw new Error("x"); }, error() { throw new Error("y"); } };
        const code = await runThumbnailCommand({
            libraryPath: "/lib", listItems: () => [{ id: "A" }], generate: async () => { throw new Error("boom"); },
            cleanup: async () => { throw new Error("close failed"); }, log: thrower
        });
        expect(code).toBe(EXIT_CODES.PARTIAL);
    });
});

describe("POST /api/scan handler", () => {
    const quiet = { info() { }, error() { } };

    test("accepted keeps the `message` key", async () => {
        const res = await createScanHandler(() => ({ kind: 'accepted', done: Promise.resolve({} as any) }), quiet)();
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("application/json");
        expect((await res.json()).message).toBe("Scan started");
    });

    test("busy is 409 with a clear message and is not claimed as started", async () => {
        const res = await createScanHandler(() => ({ kind: 'busy' }), quiet)();
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.message).toMatch(/already in progress/);
        expect(body.message).not.toBe("Scan started");
    });

    test("configuration failure is 503 with generic text only", async () => {
        const res = await createScanHandler(() => ({ kind: 'unconfigured', result: {} as any }), quiet)();
        const body = await res.json();
        expect(res.status).toBe(503);
        expect(body).toEqual({ error: SANITIZED_MESSAGES.not_configured, status: 'unavailable' });
    });

    test("unexpected errors yield a generic 500 without the raw message", async () => {
        const logged: any[] = [];
        const res = await createScanHandler(() => { throw new Error("EPERM C:\\secret\\library"); }, { info() { }, error: (...a) => logged.push(a) })();
        const text = await res.text();
        expect(res.status).toBe(500);
        expect(text).not.toContain("secret");
        expect(JSON.parse(text)).toEqual({ error: "Failed to start the scan." });
        expect(String(logged[0][1].message)).toContain("secret"); // detail stays server-side
    });

    test("end to end with the real service: unconfigured library -> 503, not 'Scan started'", async () => {
        const { service } = makeService({ libraryPath: "" });
        const res = await createScanHandler(service.startLibraryScan, quiet)();
        expect(res.status).toBe(503);
    });
});

// ---- rebuild guard ----------------------------------------------------------

describe("rebuild guard (direct)", () => {
    test("a failing unlink is reported and stops further removal", () => {
        const attempted: string[] = [];
        const result = removeDatabaseFiles("/db", {
            exists: () => true,
            unlink: (p) => { attempted.push(path.basename(p)); if (p.endsWith("library.db")) throw new Error("EBUSY: resource busy or locked"); }
        });

        expect(result.failed).toEqual({ file: "library.db", message: "EBUSY: resource busy or locked" });
        expect(result.removed).toEqual([]);
        expect(attempted).toEqual(["library.db"]);
        expect(SERVER_MUST_BE_STOPPED).toMatch(/Stop the Library Web Viewer server/);
    });

    test("removes all existing files and skips absent ones", () => {
        const result = removeDatabaseFiles("/db", {
            exists: (p) => !p.endsWith("-shm"),
            unlink: () => { }
        });
        expect(result).toEqual({ removed: DB_FILES.filter(f => !f.endsWith("-shm")) });
    });
});

// ---- subprocess CLI tests ---------------------------------------------------

const repoRoot = path.resolve(import.meta.dir, "..");

function scriptEnv(libraryPath?: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.LIBRARY_PATH;
    delete env.VERBOSE;
    if (libraryPath) env.LIBRARY_PATH = libraryPath;
    return env;
}

async function runScript(script: string, cwd: string, libraryPath?: string, timeoutMs = 60_000) {
    const proc = Bun.spawn([process.execPath, path.join(repoRoot, "scripts", script)], {
        cwd, env: scriptEnv(libraryPath), stdout: "pipe", stderr: "pipe", stdin: "ignore"
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr, timedOut, output: stdout + stderr };
}

function workDir() {
    const dir = path.join(fx.root, "work");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function indexedIds(cwd: string): string[] {
    const db = new Database(path.join(cwd, "db", "library.db"), { readonly: true });
    try {
        return (db.query("SELECT id FROM items ORDER BY id").all() as { id: string }[]).map(r => r.id);
    } finally {
        db.close();
    }
}

const CLI_TIMEOUT = 90_000;

describe("CLI scripts (subprocess, bounded by timeouts)", () => {
    for (const script of ["setup.ts", "update.ts"]) {
        describe(script, () => {
            test("genuine success -> exit 0 and items indexed", async () => {
                fx.writeRootMetadata();
                fx.writeItem("A");
                fx.writeItem("B");
                const cwd = workDir();

                const r = await runScript(script, cwd, fx.libraryPath);

                expect(r.timedOut).toBe(false);
                expect(r.code).toBe(EXIT_CODES.SUCCESS);
                expect(r.output).toContain("Result: success");
                expect(indexedIds(cwd)).toEqual(["A", "B"]);
            }, CLI_TIMEOUT);

            test("empty library -> exit 0", async () => {
                fx.writeRootMetadata();
                const r = await runScript(script, workDir(), fx.libraryPath);

                expect(r.timedOut).toBe(false);
                expect(r.code).toBe(EXIT_CODES.SUCCESS);
                expect(r.output).toContain("Result: success");
            }, CLI_TIMEOUT);

            test("missing LIBRARY_PATH -> exit 1, no hang", async () => {
                const r = await runScript(script, workDir(), undefined);

                expect(r.timedOut).toBe(false);
                expect(r.code).toBe(EXIT_CODES.FAILURE);
                expect(r.output).toContain("Result: FAILED");
                expect(r.output).toContain("LIBRARY_PATH");
            }, CLI_TIMEOUT);

            test("missing images dir -> exit 1, no hang", async () => {
                fs.rmSync(fx.imagesDir, { recursive: true, force: true });
                const r = await runScript(script, workDir(), fx.libraryPath);

                expect(r.timedOut).toBe(false);
                expect(r.code).toBe(EXIT_CODES.FAILURE);
                expect(r.output).toContain("Result: FAILED");
            }, CLI_TIMEOUT);

            test("malformed root metadata -> exit 1, no hang", async () => {
                fx.writeItem("A");
                fs.writeFileSync(path.join(fx.libraryPath, "metadata.json"), "{ nope");
                const r = await runScript(script, workDir(), fx.libraryPath);

                expect(r.timedOut).toBe(false);
                expect(r.code).toBe(EXIT_CODES.FAILURE);
                expect(r.output).toContain("Result: FAILED");
            }, CLI_TIMEOUT);

            test("unreadable item -> partial, exit 2", async () => {
                fx.writeRootMetadata();
                fx.writeItem("A");
                fs.mkdirSync(path.join(fx.imagesDir, "BAD.info", "metadata.json"), { recursive: true });
                const cwd = workDir();

                const r = await runScript(script, cwd, fx.libraryPath);

                expect(r.timedOut).toBe(false);
                expect(r.code).toBe(EXIT_CODES.PARTIAL);
                expect(r.output).toContain("Result: PARTIAL");
                expect(indexedIds(cwd)).toEqual(["A"]);
            }, CLI_TIMEOUT);
        });
    }
});

describe("verbose reporting seam (subprocess)", () => {
    test("valid global metadata + throwing verbose output does not fail the scan", async () => {
        fx.writeRootMetadata();
        fx.writeItem("A");
        const cwd = workDir();
        const env = { ...scriptEnv(fx.libraryPath), VERBOSE: "true" };
        const proc = Bun.spawn(
            [process.execPath, "--preload", path.join(repoRoot, "tests", "helpers", "injectVerboseThrow.ts"), path.join(repoRoot, "scripts", "setup.ts")],
            { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" }
        );
        const timer = setTimeout(() => proc.kill(), 60_000);
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
        ]);
        clearTimeout(timer);

        expect(code).toBe(EXIT_CODES.SUCCESS);
        expect(stdout + stderr).toContain("Result: success");
        expect(indexedIds(cwd)).toEqual(["A"]);
    }, CLI_TIMEOUT);
});

describe("generate_thumbnails.ts (subprocess, bounded by timeouts)", () => {
    const preloads = {
        item: path.join(repoRoot, "tests", "helpers", "injectExistsSyncFailure.ts"),
        enumeration: path.join(repoRoot, "tests", "helpers", "injectEnumerationFailure.ts"),
        reporter: path.join(repoRoot, "tests", "helpers", "injectThumbnailReporterThrow.ts")
    };

    async function runThumbs(cwd: string, libraryPath?: string, inject?: keyof typeof preloads) {
        const args = [process.execPath, ...(inject ? ["--preload", preloads[inject]] : []), path.join(repoRoot, "scripts", "generate_thumbnails.ts")];
        const proc = Bun.spawn(args, { cwd, env: scriptEnv(libraryPath), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 60_000);
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
        ]);
        clearTimeout(timer);
        return { code, timedOut, output: stdout + stderr };
    }

    async function writeImageItem(id: string) {
        fx.writeItem(id);
        const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ff0000" } }).png().toBuffer();
        fs.writeFileSync(path.join(fx.imagesDir, `${id}.info`, `${id}_thumbnail.png`), png);
    }

    const cached = (cwd: string, id: string) => fs.existsSync(path.join(cwd, "db", "cache", "thumbnails", `${id}.webp`));
    /** A cleanly closed WAL database leaves no -wal file behind. */
    const dbClosed = (cwd: string) => !fs.existsSync(path.join(cwd, "db", "library.db-wal"));

    test("empty library -> exit 0", async () => {
        fx.writeRootMetadata();
        const cwd = workDir();
        expect((await runScript("setup.ts", cwd, fx.libraryPath)).code).toBe(0);

        const r = await runThumbs(cwd, fx.libraryPath);

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.SUCCESS);
        expect(r.output).toContain("Found 0 items");
        expect(dbClosed(cwd)).toBe(true);
    }, CLI_TIMEOUT * 2);

    test("normal success and a legitimate skip (no image) -> exit 0", async () => {
        fx.writeRootMetadata();
        await writeImageItem("A");
        fx.writeItem("NOIMG"); // metadata only: generateThumbnail returns null, which is a skip
        const cwd = workDir();
        expect((await runScript("setup.ts", cwd, fx.libraryPath)).code).toBe(0);

        const r = await runThumbs(cwd, fx.libraryPath);

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.SUCCESS);
        expect(r.output).toContain("Errors: 0");
        expect(cached(cwd, "A")).toBe(true);
        expect(cached(cwd, "NOIMG")).toBe(false);
        expect(dbClosed(cwd)).toBe(true);
    }, CLI_TIMEOUT * 2);

    test("missing configuration -> exit 1", async () => {
        const r = await runThumbs(workDir(), undefined);

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.FAILURE);
        expect(r.output).toContain("LIBRARY_PATH");
    }, CLI_TIMEOUT);

    test("enumeration failure -> exit 1, not 'Processed: 0', resources closed", async () => {
        fx.writeRootMetadata();
        const cwd = workDir();
        expect((await runScript("setup.ts", cwd, fx.libraryPath)).code).toBe(0);

        const r = await runThumbs(cwd, fx.libraryPath, "enumeration");

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.FAILURE);
        expect(r.output).toContain("Failed to fetch items");
        expect(r.output).not.toContain("Done!");
        expect(dbClosed(cwd)).toBe(true);
    }, CLI_TIMEOUT * 2);

    test("a processing failure that returns null stays a skip when its error reporter throws -> exit 0", async () => {
        fx.writeRootMetadata();
        await writeImageItem("A");
        fx.writeItem("CORRUPT");
        fs.writeFileSync(path.join(fx.imagesDir, "CORRUPT.info", "CORRUPT_thumbnail.png"), "not an image");
        const cwd = workDir();
        expect((await runScript("setup.ts", cwd, fx.libraryPath)).code).toBe(0);

        const r = await runThumbs(cwd, fx.libraryPath, "reporter");

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.SUCCESS);
        expect(r.output).toContain("Skipped: 1");
        expect(r.output).toContain("Errors: 0");
        expect(r.output).not.toContain("Failed CORRUPT");
        expect(cached(cwd, "A")).toBe(true);
        expect(cached(cwd, "CORRUPT")).toBe(false);
    }, CLI_TIMEOUT * 2);

    test("database cannot be opened (lazy import rejects) -> exit 1, reported, no hang", async () => {
        fx.writeRootMetadata();
        await writeImageItem("A");
        const cwd = workDir();
        fs.writeFileSync(path.join(cwd, "db"), "a file where the db directory must be");

        const r = await runThumbs(cwd, fx.libraryPath);

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.FAILURE);
        expect(r.output).toContain("Fatal error");
        expect(r.output).not.toContain("Done!");
    }, CLI_TIMEOUT);

    test("caught item errors -> exit 2, other items still generated, resources closed", async () => {
        fx.writeRootMetadata();
        await writeImageItem("A");
        await writeImageItem("BAD");
        const cwd = workDir();
        expect((await runScript("setup.ts", cwd, fx.libraryPath)).code).toBe(0);

        const r = await runThumbs(cwd, fx.libraryPath, "item");

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.PARTIAL);
        expect(r.output).toContain("Failed BAD");
        expect(r.output).toContain("Errors: 1");
        expect(cached(cwd, "A")).toBe(true);
        expect(dbClosed(cwd)).toBe(true);
    }, CLI_TIMEOUT * 2);
});

describe("rebuild.ts (subprocess)", () => {
    test("rebuilds from scratch on a temp fixture and exits 0", async () => {
        fx.writeRootMetadata();
        fx.writeItem("A");
        const cwd = workDir();
        expect((await runScript("setup.ts", cwd, fx.libraryPath)).code).toBe(0);
        fx.writeItem("B");

        const r = await runScript("rebuild.ts", cwd, fx.libraryPath);

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.SUCCESS);
        expect(r.output).toContain("Deleted library.db");
        expect(indexedIds(cwd)).toEqual(["A", "B"]);
    }, CLI_TIMEOUT * 2);

    test("a database file that cannot be removed -> exit 1, clear message, no scan, nothing else touched", async () => {
        // Injection: library.db is a directory, so unlink fails deterministically on every OS
        // (file locking of a live SQLite handle is unreliable to provoke in a test on Windows).
        fx.writeRootMetadata();
        fx.writeItem("A");
        const cwd = workDir();
        const blocker = path.join(cwd, "db", "library.db");
        fs.mkdirSync(blocker, { recursive: true });
        fs.writeFileSync(path.join(blocker, "keep.txt"), "x");
        fs.writeFileSync(path.join(cwd, "db", "library.db-wal"), "wal");

        const r = await runScript("rebuild.ts", cwd, fx.libraryPath);

        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(EXIT_CODES.FAILURE);
        expect(r.output).toContain("could not delete library.db");
        expect(r.output).toContain("Stop the Library Web Viewer server");
        expect(r.output).not.toContain("Scanning");
        expect(fs.existsSync(path.join(blocker, "keep.txt"))).toBe(true);
        expect(fs.existsSync(path.join(cwd, "db", "library.db-wal"))).toBe(true);
    }, CLI_TIMEOUT);
});

// ---- helpers ---------------------------------------------------------------

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 5000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}
