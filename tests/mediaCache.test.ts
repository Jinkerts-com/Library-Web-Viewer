import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    MEDIA_CACHE_CONTROL, MediaGenerationCoordinator, THUMBNAIL_DEFAULTS, contentEtag, fileEtag,
    resolveThumbnailSettings
} from '../src/lib/mediaCache';
import { MEDIA_CACHE_EPOCH, originalUrl, previewUrl, thumbnailUrl, withMediaEpoch } from '../src/lib/mediaUrls';
import { createOriginalHandler, createPreviewHandler, createThumbnailHandler } from '../src/lib/mediaHandlers';
import { getPlaceholderResponse } from '../src/lib/placeholder';
import { authorizeItem, type AccessDeps, type AccessItem, type LockState } from '../src/lib/itemAccess';
import { lockStateFromCache, publishLockSnapshot } from '../src/lib/lockSnapshot';
import { createWatcherRouter, type WatcherTimers } from '../src/lib/watcherEvents';
import { clearDerivedCaches, DERIVED_CACHE_DIRS, type CacheClearOps } from '../src/lib/rebuildGuard';
import { createLibraryFixture, type LibraryFixture } from './helpers/libraryFixture';

const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

// ---- thumbnail settings ------------------------------------------------------

describe("thumbnail settings (R11)", () => {
    const run = (env: Record<string, string | undefined>) => {
        const warnings: string[] = [];
        const settings = resolveThumbnailSettings(env, (m) => warnings.push(m));
        return { settings, warnings };
    };

    test("unset or blank -> defaults, no warning", () => {
        for (const env of [{}, { THUMBNAIL_HEIGHT: "", THUMBNAIL_QUALITY: "  " }]) {
            const { settings, warnings } = run(env);
            expect(settings).toEqual({ height: 400, quality: 80 });
            expect(warnings).toEqual([]);
        }
        expect(THUMBNAIL_DEFAULTS).toEqual({ height: 400, quality: 80 });
    });

    test("valid values (including bounds) are honored", () => {
        expect(run({ THUMBNAIL_HEIGHT: "256", THUMBNAIL_QUALITY: "55" })).toEqual({ settings: { height: 256, quality: 55 }, warnings: [] });
        expect(run({ THUMBNAIL_HEIGHT: "16", THUMBNAIL_QUALITY: "1" }).settings).toEqual({ height: 16, quality: 1 });
        expect(run({ THUMBNAIL_HEIGHT: "2000", THUMBNAIL_QUALITY: "100" }).settings).toEqual({ height: 2000, quality: 100 });
        expect(run({ THUMBNAIL_HEIGHT: " 300 " }).settings.height).toBe(300);
    });

    test("NaN / garbage / negative / zero / oversized / fractional -> default + warning, never NaN", () => {
        const bad = ["abc", "NaN", "-5", "0", "15", "2001", "99999999999999999999", "12.5", "1e3", "0x10", "400px", "Infinity"];
        for (const value of bad) {
            const h = run({ THUMBNAIL_HEIGHT: value });
            expect(h.settings.height).toBe(400);
            expect(h.warnings.length).toBe(1);
            expect(h.warnings[0]).toContain("THUMBNAIL_HEIGHT");
            if (value === "15") continue; // below the height minimum, but a valid quality
            const q = run({ THUMBNAIL_QUALITY: value });
            expect(q.settings.quality).toBe(80);
            expect(q.warnings.length).toBe(1);
            expect(q.warnings[0]).toContain("THUMBNAIL_QUALITY");
        }
        for (const value of ["101", "-1"]) expect(run({ THUMBNAIL_QUALITY: value }).settings.quality).toBe(80);
    });

    test("whatever the environment holds, resolved values are bounded integers (what sharp receives)", () => {
        for (const value of ["", "x", "NaN", "-1", "0", "7", "50", "100000", undefined]) {
            const { settings } = run({ THUMBNAIL_HEIGHT: value, THUMBNAIL_QUALITY: value });
            expect(Number.isInteger(settings.height) && settings.height >= 16 && settings.height <= 2000).toBe(true);
            expect(Number.isInteger(settings.quality) && settings.quality >= 1 && settings.quality <= 100).toBe(true);
        }
    });

    test("a throwing warning reporter does not escape", () => {
        expect(() => resolveThumbnailSettings({ THUMBNAIL_HEIGHT: "x" }, () => { throw new Error("closed pipe"); })).not.toThrow();
    });
});

// ---- cache headers -----------------------------------------------------------

const items: Record<string, AccessItem> = {
    open: { id: "open", name: "o", ext: "png", folders: [] },
    locked: { id: "locked", name: "l", ext: "png", folders: ["F"] }
};
const lockState: LockState = { ready: true, folders: [{ id: "F", children: [] }], lockedFolderIds: new Set(["F"]) };
const access: AccessDeps = { getLockState: () => lockState, lookupItem: (id) => items[id] ?? null };
const call = (handler: any, id: string, init?: RequestInit, params: Record<string, string> = { id }) =>
    handler({ params, request: new Request("http://localhost/x", init) }) as Promise<Response>;

describe("media cache headers (R08)", () => {
    const bytes = Buffer.from("webp-bytes");
    const modified = Date.UTC(2024, 0, 2, 3, 4, 5);

    function expectRevalidationPolicy(res: Response) {
        const cc = res.headers.get("cache-control") ?? "";
        expect(cc).toBe(MEDIA_CACHE_CONTROL);
        expect(cc).not.toContain("immutable");
        expect(cc).not.toContain("public");
        expect(cc).not.toMatch(/max-age=[1-9]/);
    }

    for (const kind of ["thumbnail", "preview"] as const) {
        const make = (generated: { n: number }) => {
            const common = { access, lastModified: () => modified };
            return kind === "thumbnail"
                ? createThumbnailHandler({ ...common, generateThumbnail: async () => { generated.n++; return bytes; } })
                : createPreviewHandler({ ...common, generatePreview: async () => { generated.n++; return bytes; } });
        };

        test(`${kind}: private revalidation policy with ETag + Last-Modified`, async () => {
            const res = await call(make({ n: 0 }), "open");
            expect(res.status).toBe(200);
            expectRevalidationPolicy(res);
            expect(res.headers.get("etag")).toBe(contentEtag(bytes));
            expect(res.headers.get("last-modified")).toBe(new Date(modified).toUTCString());
            expect(res.headers.get("content-type")).toBe("image/webp");
            expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
        });

        test(`${kind}: matching If-None-Match -> 304 without a body; wrong ETag -> 200`, async () => {
            const handler = make({ n: 0 });
            const etag = contentEtag(bytes);

            for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
                const res = await call(handler, "open", { headers: { "if-none-match": header } });
                expect(res.status).toBe(304);
                expect(await res.text()).toBe("");
                expect(res.headers.get("etag")).toBe(etag);
                expectRevalidationPolicy(res);
            }

            const wrong = await call(handler, "open", { headers: { "if-none-match": '"stale"' } });
            expect(wrong.status).toBe(200);
            expect((await wrong.arrayBuffer()).byteLength).toBe(bytes.length);
        });

        test(`${kind}: If-Modified-Since is honored only without If-None-Match`, async () => {
            const handler = make({ n: 0 });
            const later = new Date(modified + 5000).toUTCString();
            const earlier = new Date(modified - 5000).toUTCString();

            expect((await call(handler, "open", { headers: { "if-modified-since": later } })).status).toBe(304);
            expect((await call(handler, "open", { headers: { "if-modified-since": earlier } })).status).toBe(200);
            // If-None-Match present and not matching wins over a satisfied If-Modified-Since
            expect((await call(handler, "open", { headers: { "if-none-match": '"stale"', "if-modified-since": later } })).status).toBe(200);
        });

        test(`${kind}: authorization precedes the cache - a matching ETag does not reveal a locked item`, async () => {
            const generated = { n: 0 };
            const res = await call(make(generated), "locked", { headers: { "if-none-match": contentEtag(bytes) } });
            expect(res.status).toBe(404);
            expect(generated.n).toBe(0);
            expect(res.headers.get("etag")).toBeNull();
        });
    }

    test("placeholder (authorized item without a thumbnail) is no longer publicly cacheable", async () => {
        const res = getPlaceholderResponse();
        expect(res.headers.get("cache-control")).toBe("private, no-cache");
        const viaHandler = await call(createThumbnailHandler({ access, generateThumbnail: async () => null }), "open");
        expect(viaHandler.status).toBe(200);
        expect(viaHandler.headers.get("content-type")).toBe("image/svg+xml");
        expect(viaHandler.headers.get("cache-control")).not.toContain("public");
    });

    describe("originals", () => {
        let fx: LibraryFixture;
        beforeEach(() => { fx = createLibraryFixture(); });
        afterEach(() => { fx.cleanup(); });

        const fileBody = Buffer.from("0123456789");
        const original = (id = "open") => {
            const dir = path.join(fx.imagesDir, `${id}.info`);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "o.png"), fileBody);
            return createOriginalHandler({ access, getLibraryPath: () => fx.libraryPath });
        };
        const get = (handler: any, init?: RequestInit) => call(handler, "open", init, { path: "open.info/o.png" });

        test("200 carries the private revalidation policy and validators; 304 on a matching tag; wrong tag -> 200", async () => {
            const handler = original();
            const res = await get(handler);
            expect(res.status).toBe(200);
            expectRevalidationPolicy(res);
            const stat = fs.statSync(path.join(fx.imagesDir, "open.info", "o.png"));
            expect(res.headers.get("etag")).toBe(fileEtag(stat.size, stat.mtimeMs));
            expect(res.headers.get("last-modified")).toBe(new Date(stat.mtimeMs).toUTCString());
            expect(Buffer.from(await res.arrayBuffer()).equals(fileBody)).toBe(true);

            const etag = res.headers.get("etag")!;
            const notModified = await get(handler, { headers: { "if-none-match": etag } });
            expect(notModified.status).toBe(304);
            expect(await notModified.text()).toBe("");
            expect((await get(handler, { headers: { "if-none-match": '"nope"' } })).status).toBe(200);
        });

        test("a changed original changes the validator (no stale 304)", async () => {
            const handler = original();
            const etag = (await get(handler)).headers.get("etag")!;
            const file = path.join(fx.imagesDir, "open.info", "o.png");
            fs.writeFileSync(file, Buffer.from("different, longer content"));
            const res = await get(handler, { headers: { "if-none-match": etag } });
            expect(res.status).toBe(200);
            expect(res.headers.get("etag")).not.toBe(etag);
        });

        test("range responses keep the policy", async () => {
            const res = await get(original(), { headers: { range: "bytes=0-3" } });
            expect(res.status).toBe(206);
            expectRevalidationPolicy(res);
            expect(res.headers.get("etag")).toBeTruthy();
        });

        test("locked original stays 404 even with a matching tag", async () => {
            const handler = original("locked");
            const res = await call(handler, "locked", { headers: { "if-none-match": "*" } }, { path: "locked.info/o.png" });
            expect(res.status).toBe(404);
        });
    });
});

// ---- URL epoch ---------------------------------------------------------------

describe("cache-policy epoch in app-constructed URLs", () => {
    test("every media URL carries ?v=<epoch>; the bare legacy form is never produced", () => {
        const v = `?v=${encodeURIComponent(MEDIA_CACHE_EPOCH)}`;
        expect(thumbnailUrl("ID1")).toBe(`/api/thumbnail/ID1${v}`);
        expect(previewUrl("ID1")).toBe(`/api/preview/ID1${v}`);
        expect(originalUrl("ID1", "pic", "jpg")).toBe(`/images/ID1.info/pic.jpg${v}`);
        for (const url of [thumbnailUrl("ID1"), previewUrl("ID1"), originalUrl("ID1", "pic", "jpg")]) {
            expect(url).not.toBe(url.split("?")[0]);
        }
    });

    test("changing the epoch changes every URL (so a bumped constant re-fetches)", () => {
        expect(thumbnailUrl("A", "3")).not.toBe(thumbnailUrl("A", "2"));
        expect(previewUrl("A", "3")).not.toBe(previewUrl("A", "2"));
        expect(originalUrl("A", "n", "png", "3")).not.toBe(originalUrl("A", "n", "png", "2"));
        expect(withMediaEpoch("/x", "9")).toBe("/x?v=9");
    });

    test("the epoch moved past the legacy (unversioned) form", () => {
        expect(MEDIA_CACHE_EPOCH).not.toBe("");
        expect(MEDIA_CACHE_EPOCH).not.toBe("1");
    });

    test("components build media URLs only through mediaUrls (guards against reverting to bare URLs)", () => {
        const grid = fs.readFileSync(path.join(process.cwd(), "src", "components", "ImageGrid.tsx"), "utf8");
        const modal = fs.readFileSync(path.join(process.cwd(), "src", "components", "Modal.tsx"), "utf8");
        for (const source of [grid, modal]) {
            expect(source).toContain("lib/mediaUrls");
            expect(source).not.toMatch(/`\/api\/(thumbnail|preview)\//);
            expect(source).not.toMatch(/`\/images\//);
        }
        expect(grid).toContain("thumbnailUrl(");
        expect(modal).toContain("previewUrl(");
        expect(modal).toContain("originalUrl(");
    });
});

// ---- generation / invalidation coordination -----------------------------------

describe("MediaGenerationCoordinator", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwv-media-")); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const deferred = () => {
        let release!: () => void;
        const promise = new Promise<void>(r => { release = r; });
        return { promise, release };
    };
    const file = (name: string) => path.join(dir, `${name}.webp`);

    test("invalidation mid-flight: the stale result is returned to its caller but never cached", async () => {
        const coord = new MediaGenerationCoordinator(4);
        const gate = deferred();
        const job = coord.generate("thumbnail", "X", file("X"), async () => { await gate.promise; return Buffer.from("old"); });

        coord.invalidate("X");
        gate.release();

        expect((await job)!.toString()).toBe("old");
        expect(fs.existsSync(file("X"))).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]); // no temp file left behind
    });

    test("invalidation inside the temp-file write window (producer done, publish pending) is discarded at the fence", async () => {
        const coord = new MediaGenerationCoordinator(4);
        const writeDone = deferred();
        const proceed = deferred();
        const realWrite = fs.promises.writeFile.bind(fs.promises);
        const spy = spyOn(fs.promises, "writeFile").mockImplementation((async (...args: Parameters<typeof fs.promises.writeFile>) => {
            await realWrite(...args);
            writeDone.release(); // the temp file is fully on disk; the check + rename have not run yet
            await proceed.promise;
        }) as any);
        try {
            const job = coord.generate("thumbnail", "W", file("W"), async () => Buffer.from("old"));
            await writeDone.promise;
            expect(fs.readdirSync(dir).some(f => f.endsWith(".tmp"))).toBe(true); // really inside the window
            expect(fs.existsSync(file("W"))).toBe(false);

            coord.invalidate("W");
            proceed.release();

            expect((await job)!.toString()).toBe("old"); // caller still served
            expect(fs.existsSync(file("W"))).toBe(false); // never published
            expect(fs.readdirSync(dir)).toEqual([]); // temp discarded
        } finally {
            spy.mockRestore();
        }
    });

    test("a request after invalidation starts fresh work; the older job can not overwrite the newer cache", async () => {
        const coord = new MediaGenerationCoordinator(4);
        const gate = deferred();
        const oldJob = coord.generate("preview", "X", file("X"), async () => { await gate.promise; return Buffer.from("old"); });

        coord.invalidate("X");
        const fresh = await coord.generate("preview", "X", file("X"), async () => Buffer.from("new"));
        expect(fresh!.toString()).toBe("new");
        expect(fs.readFileSync(file("X"), "utf8")).toBe("new");

        gate.release();
        await oldJob;
        expect(fs.readFileSync(file("X"), "utf8")).toBe("new");
        expect(fs.readdirSync(dir)).toEqual(["X.webp"]);
        expect(coord.inFlight).toBe(0);
    });

    test("invalidation fences only the invalidated item", async () => {
        const coord = new MediaGenerationCoordinator(4);
        const gate = deferred();
        const a = coord.generate("thumbnail", "A", file("A"), async () => { await gate.promise; return Buffer.from("a"); });
        const b = coord.generate("thumbnail", "B", file("B"), async () => { await gate.promise; return Buffer.from("b"); });
        coord.invalidate("A");
        gate.release();
        await Promise.all([a, b]);
        expect(fs.existsSync(file("A"))).toBe(false);
        expect(fs.readFileSync(file("B"), "utf8")).toBe("b");
    });

    test("concurrent requests for one item coalesce into a single generation", async () => {
        const coord = new MediaGenerationCoordinator(4);
        const gate = deferred();
        let produced = 0;
        const produce = async () => { produced++; await gate.promise; return Buffer.from("once"); };

        const all = Array.from({ length: 8 }, () => coord.generate("thumbnail", "C", file("C"), produce));
        gate.release();
        const results = await Promise.all(all);

        expect(produced).toBe(1);
        expect(results.every(r => r!.toString() === "once")).toBe(true);
        expect(coord.inFlight).toBe(0);
    });

    test("thumbnails and previews of one item are separate jobs", async () => {
        const coord = new MediaGenerationCoordinator(4);
        let produced = 0;
        const make = (label: string) => async () => { produced++; return Buffer.from(label); };
        await Promise.all([
            coord.generate("thumbnail", "D", file("D-t"), make("t")),
            coord.generate("preview", "D", file("D-p"), make("p"))
        ]);
        expect(produced).toBe(2);
    });

    test("aggregate concurrency is bounded and every queued job completes", async () => {
        const coord = new MediaGenerationCoordinator(3);
        let active = 0;
        let peak = 0;
        const produce = async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 15));
            active--;
            return Buffer.from("x");
        };
        const ids = Array.from({ length: 12 }, (_, i) => `I${i}`);
        const results = await Promise.all(ids.map((id, i) => coord.generate(i % 2 ? "thumbnail" : "preview", id, file(id), produce)));

        expect(results.length).toBe(12);
        expect(peak).toBe(3);
        expect(active).toBe(0);
    });

    test("a failing producer releases its slot and leaves nothing cached", async () => {
        const coord = new MediaGenerationCoordinator(1);
        await expect(coord.generate("thumbnail", "E", file("E"), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
        const next = await coord.generate("thumbnail", "F", file("F"), async () => Buffer.from("ok"));
        expect(next!.toString()).toBe("ok");
        expect(fs.existsSync(file("E"))).toBe(false);
    });

    test("null (nothing to generate) is not cached", async () => {
        const coord = new MediaGenerationCoordinator(2);
        expect(await coord.generate("thumbnail", "G", file("G"), async () => null)).toBeNull();
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test("cache writes are atomic: a failed write leaves no partial file and still serves the bytes", async () => {
        const errors: unknown[][] = [];
        const coord = new MediaGenerationCoordinator(2, { error: (...a) => errors.push(a) });
        const missingDir = path.join(dir, "no-such-dir", "H.webp");
        const result = await coord.generate("thumbnail", "H", missingDir, async () => Buffer.from("bytes"));
        expect(result!.toString()).toBe("bytes");
        expect(errors.length).toBe(1);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});

// ---- watcher coverage --------------------------------------------------------

function fakeTimers() {
    let now = 0;
    let seq = 0;
    const queue = new Map<number, { at: number; fn: () => void }>();
    const timers: WatcherTimers = {
        setTimeout: (fn, ms) => { const id = ++seq; queue.set(id, { at: now + ms, fn }); return id; },
        clearTimeout: (h) => { queue.delete(h as number); }
    };
    return {
        timers,
        get size() { return queue.size; },
        /** Advances time, firing due timers in order (including ones scheduled meanwhile). */
        async advance(ms: number) {
            const target = now + ms;
            for (; ;) {
                const due = [...queue.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                queue.delete(due[0]);
                now = due[1].at;
                due[1].fn();
                await settle();
            }
            now = target;
        }
    };
}

describe("watcher events (R09)", () => {
    let fx: LibraryFixture;
    beforeEach(() => { fx = createLibraryFixture(); });
    afterEach(() => { fx.cleanup(); });

    const DEBOUNCE = 500;
    const RETRY = [100, 200, 400];

    function setup(opts: { retryDelaysMs?: number[] } = {}) {
        const clock = fakeTimers();
        const snapshot = { folders: [] as any[], tagsGroups: [] as any[], lockedFolderIds: new Set<string>(), lastUpdated: 0 };
        const invalidated: string[] = [];
        const indexer = fx.createIndexer({
            invalidateCache: (id) => { invalidated.push(id); },
            onLibraryMetadata: (m) => publishLockSnapshot(snapshot, m).ok
        });
        const router = createWatcherRouter({
            libraryPath: fx.libraryPath,
            indexer,
            invalidateCache: (id) => { invalidated.push(id); },
            timers: clock.timers,
            debounceMs: DEBOUNCE,
            retryDelaysMs: opts.retryDelaysMs ?? RETRY
        });
        return { clock, snapshot, invalidated, router, indexer };
    }
    const rootMeta = () => path.join(fx.libraryPath, "metadata.json");

    test("root metadata change republishes the lock snapshot without a rescan (new password folder becomes locked)", async () => {
        fx.writeRootMetadata({ folders: [{ id: "F1", name: "F", children: [] }], tagsGroups: [] });
        const { clock, snapshot, router } = setup();
        publishLockSnapshot(snapshot, JSON.parse(fs.readFileSync(rootMeta(), "utf8")));
        const deps = (): AccessDeps => ({
            getLockState: () => lockStateFromCache(snapshot),
            lookupItem: () => ({ id: "I", name: "n", ext: "png", folders: ["F1"] })
        });
        const req = new Request("http://localhost/x");
        expect(authorizeItem(deps(), req, "I").ok).toBe(true);

        fx.writeRootMetadata({ folders: [{ id: "F1", name: "F", password: "secret", children: [] }], tagsGroups: [{ name: "g", tags: ["t"] }] });
        router.onFileEvent(rootMeta(), "change");
        expect(snapshot.lockedFolderIds.has("F1")).toBe(false); // debounced, not yet applied
        await clock.advance(DEBOUNCE);

        expect(snapshot.lockedFolderIds.has("F1")).toBe(true);
        expect(snapshot.tagsGroups.length).toBe(1);
        expect(authorizeItem(deps(), req, "I")).toEqual({ ok: false, status: 404 });
    });

    test("root metadata partially written (invalid JSON) keeps the previous locks, then applies once complete", async () => {
        fx.writeRootMetadata({ folders: [{ id: "F1", name: "F", password: "pw", children: [] }], tagsGroups: [] });
        const { clock, snapshot, router } = setup();
        publishLockSnapshot(snapshot, JSON.parse(fs.readFileSync(rootMeta(), "utf8")));

        fs.writeFileSync(rootMeta(), '{ "folders": [{ "id": "F1", "na');
        router.onFileEvent(rootMeta(), "change");
        await clock.advance(DEBOUNCE);
        expect(snapshot.lockedFolderIds.has("F1")).toBe(true); // never "ready, nothing locked"
        expect(clock.size).toBe(1); // a retry is scheduled

        fx.writeRootMetadata({ folders: [{ id: "F1", name: "F", children: [] }, { id: "F2", name: "G", password: "x", children: [] }], tagsGroups: [] });
        await clock.advance(RETRY[0]);
        expect([...snapshot.lockedFolderIds]).toEqual(["F2"]);
    });

    test("root metadata deletion never unlocks anything", async () => {
        fx.writeRootMetadata({ folders: [{ id: "F1", name: "F", password: "pw", children: [] }], tagsGroups: [] });
        const { clock, snapshot, router } = setup();
        publishLockSnapshot(snapshot, JSON.parse(fs.readFileSync(rootMeta(), "utf8")));
        fs.rmSync(rootMeta());
        router.onFileEvent(rootMeta(), "unlink");
        await clock.advance(10_000);
        expect(snapshot.lockedFolderIds.has("F1")).toBe(true);
    });

    test("original file change invalidates that item's generated cache (debounced, once per burst)", async () => {
        const { clock, invalidated, router } = setup();
        const orig = path.join(fx.imagesDir, "A.info", "photo.png");
        for (const kind of ["change", "change", "add"] as const) router.onFileEvent(orig, kind);
        router.onFileEvent(path.join(fx.imagesDir, "A.info", "photo_thumbnail.png"), "change");
        router.onFileEvent(path.join(fx.imagesDir, "B.info", "other.jpg"), "unlink");
        expect(invalidated).toEqual([]);

        await clock.advance(DEBOUNCE);
        expect(invalidated.sort()).toEqual(["A", "B"]);
    });

    test("unrelated paths are ignored", async () => {
        const { clock, invalidated, router } = setup();
        router.onFileEvent(path.join(fx.libraryPath, "other.txt"), "change");
        router.onFileEvent(path.join(fx.imagesDir, "loose.png"), "add");
        router.onFileEvent(path.join(fx.imagesDir, "notinfo", "x.png"), "add");
        router.onFileEvent(path.join(fx.root, "elsewhere", "metadata.json"), "change");
        expect(clock.size).toBe(0);
        await clock.advance(10_000);
        expect(invalidated).toEqual([]);
    });

    test("item metadata change re-indexes and invalidates", async () => {
        fx.seedRow("M", { name: "Old", last_scanned: 1000 });
        fx.writeItem("M", { name: "New" });
        const { clock, invalidated, router } = setup();
        router.onFileEvent(fx.itemMetaPath("M"), "change");
        await clock.advance(DEBOUNCE);
        expect(fx.getRow("M")!.name).toBe("New");
        expect(invalidated).toContain("M");
    });

    test("partial metadata write (invalid JSON, then valid within the retry window) is re-indexed, not left failed", async () => {
        fx.seedRow("P", { name: "Old", last_scanned: 1000 });
        fx.writeRawMetadata("P", '{ "name": "Half');
        const { clock, router } = setup();

        router.onFileEvent(fx.itemMetaPath("P"), "change");
        await clock.advance(DEBOUNCE);
        // Unreadable now: row untouched, flagged for the next scan, retry pending
        expect(fx.getRow("P")!.name).toBe("Old");
        expect(fx.getRow("P")!.last_scanned).toBe(0);
        expect(clock.size).toBe(1);

        fx.writeItem("P", { name: "Complete" });
        await clock.advance(RETRY[0]);
        expect(fx.getRow("P")!.name).toBe("Complete");
        expect(fx.getRow("P")!.last_scanned).toBeGreaterThan(0);
        expect(clock.size).toBe(0);
    });

    test("a new event restarts the retry sequence; exhausted retries leave the item retry-eligible for the next scan", async () => {
        fx.seedRow("R", { name: "Old", last_scanned: 1000 });
        fx.writeRawMetadata("R", "{ broken");
        const { clock, router } = setup({ retryDelaysMs: [50, 50] });

        router.onFileEvent(fx.itemMetaPath("R"), "change");
        await clock.advance(DEBOUNCE + 50 + 50 + 1000);
        expect(clock.size).toBe(0); // gave up (bounded)
        expect(fx.getRow("R")!.last_scanned).toBe(0); // but NOT permanently failed

        fx.writeItem("R", { name: "Fixed" });
        const scan = await fx.createIndexer().scan();
        expect(scan.status).toBe("complete");
        expect(fx.getRow("R")!.name).toBe("Fixed");
    });

    test("bursts of metadata events collapse into one indexing run", async () => {
        fx.writeItem("S", { name: "S1" });
        const { clock, router } = setup();
        let runs = 0;
        const original = fx.getRow;
        void original;
        const counting = createWatcherRouter({
            libraryPath: fx.libraryPath,
            indexer: {
                itemChanged: async () => { runs++; return "applied"; },
                itemRemoved: async () => "applied",
                refreshLibraryMetadata: async () => "applied"
            },
            invalidateCache: () => { },
            timers: clock.timers,
            debounceMs: DEBOUNCE
        });
        for (let i = 0; i < 5; i++) { counting.onFileEvent(fx.itemMetaPath("S"), "change"); await clock.advance(100); }
        await clock.advance(DEBOUNCE);
        expect(runs).toBe(1);
        router.dispose();
    });

    test("removing an item directory removes the row at once and cancels pending work", async () => {
        fx.writeItem("Z");
        const { clock, invalidated, router } = setup();
        await fx.createIndexer().scan();
        expect(fx.rowIds()).toContain("Z");

        router.onFileEvent(path.join(fx.imagesDir, "Z.info", "photo.png"), "change");
        fx.removeItem("Z");
        router.onDirRemoved(path.join(fx.imagesDir, "Z.info"));
        await settle();
        expect(fx.rowIds()).not.toContain("Z");
        expect(clock.size).toBe(0);
        expect(invalidated).toContain("Z"); // deleteItem invalidates through the indexer
    });

    test("only a top-level <id>.info directory counts as an item removal", async () => {
        fx.writeItem("Y");
        await fx.createIndexer().scan();
        const { router } = setup();
        router.onDirRemoved(path.join(fx.imagesDir, "Y.info", "nested.info"));
        router.onDirRemoved(path.join(fx.imagesDir, "Y.info", "sub"));
        await settle();
        expect(fx.rowIds()).toContain("Y");
    });

    test("dispose cancels pending timers and ignores later events", async () => {
        const { clock, invalidated, router } = setup();
        router.onFileEvent(path.join(fx.imagesDir, "A.info", "p.png"), "change");
        router.dispose();
        router.onFileEvent(path.join(fx.imagesDir, "B.info", "p.png"), "change");
        expect(clock.size).toBe(0);
        await clock.advance(10_000);
        expect(invalidated).toEqual([]);
    });

    test("root metadata change during a scan is replayed after it (not lost)", async () => {
        fx.writeRootMetadata({ folders: [], tagsGroups: [] });
        fx.writeItem("A");
        const snapshot = { folders: [] as any[], tagsGroups: [] as any[], lockedFolderIds: new Set<string>(), lastUpdated: 0 };
        let changedDuringScan = false;
        let queuedRefresh: Promise<string> | undefined;
        const indexer = fx.createIndexer({
            onLibraryMetadata: (m) => publishLockSnapshot(snapshot, m).ok,
            fs: {
                readFile: async (p) => {
                    const text = await fs.promises.readFile(p, "utf8");
                    if (!changedDuringScan && p === fx.itemMetaPath("A")) {
                        changedDuringScan = true;
                        fx.writeRootMetadata({ folders: [{ id: "L", name: "L", password: "pw", children: [] }], tagsGroups: [] });
                        queuedRefresh = indexer.refreshLibraryMetadata();
                    }
                    return text;
                }
            }
        });
        await indexer.scan();
        expect(snapshot.lockedFolderIds.has("L")).toBe(true);
        expect(await queuedRefresh).toBe("applied"); // the queued caller receives the real replay outcome
    });
});

// ---- rebuild -----------------------------------------------------------------

describe("rebuild clears derived caches only (R09/plan)", () => {
    let dbDir: string;
    beforeEach(() => { dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwv-rebuild-")); });
    afterEach(() => { fs.rmSync(dbDir, { recursive: true, force: true }); });

    const put = (...segments: string[]) => {
        const p = path.join(dbDir, ...segments);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x");
        return p;
    };

    test("empties thumbnails and previews (including stray temp files); keeps the directories and everything else", () => {
        put("library.db");
        const t1 = put("cache", "thumbnails", "A.webp");
        const t2 = put("cache", "thumbnails", "A.webp.123.abc.tmp");
        const p1 = put("cache", "previews", "A.webp");
        const p2 = put("cache", "previews", "_temp_exiftool_preview_A.jpg");
        const other = put("cache", "other", "keep.txt");
        const sibling = put("keep.txt");

        const result = clearDerivedCaches(dbDir);

        expect(result).toEqual({ removed: 4 });
        for (const gone of [t1, t2, p1, p2]) expect(fs.existsSync(gone)).toBe(false);
        for (const dir of DERIVED_CACHE_DIRS) expect(fs.statSync(path.join(dbDir, "cache", dir)).isDirectory()).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
        expect(fs.existsSync(sibling)).toBe(true);
        expect(fs.existsSync(path.join(dbDir, "library.db"))).toBe(true); // DB files are removeDatabaseFiles' job
    });

    test("missing cache directories are fine", () => {
        expect(clearDerivedCaches(dbDir)).toEqual({ removed: 0 });
    });

    test("a removal failure is reported and stops", () => {
        put("cache", "thumbnails", "A.webp");
        const real = defaultOps();
        const result = clearDerivedCaches(dbDir, { ...real, remove: () => { throw new Error("EBUSY"); } });
        expect(result.failed?.message).toBe("EBUSY");
        expect(result.failed?.file).toContain("thumbnails");
    });

    // Real links: junctions on Windows (no privilege needed), directory symlinks elsewhere.
    const link = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
    let external: string;
    beforeEach(() => {
        external = fs.mkdtempSync(path.join(os.tmpdir(), "lwv-external-"));
        for (const name of DERIVED_CACHE_DIRS) {
            fs.mkdirSync(path.join(external, name), { recursive: true });
            fs.writeFileSync(path.join(external, name, "precious.bin"), "keep");
        }
    });
    afterEach(() => { fs.rmSync(external, { recursive: true, force: true }); });
    const externalIntact = () => DERIVED_CACHE_DIRS.every(n => fs.readFileSync(path.join(external, n, "precious.bin"), "utf8") === "keep");

    test("a linked `cache` ancestor is never traversed: external thumbnails/previews survive", () => {
        fs.mkdirSync(dbDir, { recursive: true });
        link(external, path.join(dbDir, "cache"));
        const result = clearDerivedCaches(dbDir);
        expect(result).toEqual({ removed: 0, skipped: ["cache"] });
        expect(externalIntact()).toBe(true);
    });

    test("a linked thumbnail or preview leaf is skipped and reported; the other real directory is still cleared", () => {
        const kept = put("cache", "previews", "A.webp");
        link(path.join(external, "thumbnails"), path.join(dbDir, "cache", "thumbnails"));
        const result = clearDerivedCaches(dbDir);
        expect(result.removed).toBe(1);
        expect(result.skipped).toEqual([path.join("cache", "thumbnails")]);
        expect(fs.existsSync(kept)).toBe(false);
        expect(externalIntact()).toBe(true);
    });

    test("a link inside a legitimate derived directory loses only the link, never its target", () => {
        put("cache", "thumbnails", "A.webp");
        link(external, path.join(dbDir, "cache", "thumbnails", "escape"));
        const result = clearDerivedCaches(dbDir);
        expect(result).toEqual({ removed: 2 });
        expect(fs.readdirSync(path.join(dbDir, "cache", "thumbnails"))).toEqual([]);
        expect(externalIntact()).toBe(true);
    });

    test("an inspection failure fails the clear instead of silently skipping (cache, then leaf)", () => {
        put("cache", "thumbnails", "A.webp");
        const real = defaultOps();
        const denied = (match: string) => ({
            ...real,
            inspect: (p: string) => { if (p.endsWith(match)) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); return real.inspect(p); }
        });

        const onCache = clearDerivedCaches(dbDir, denied("cache"));
        expect(onCache.failed?.file).toBe("cache");
        expect(onCache.failed?.message).toContain("EACCES");

        const onLeaf = clearDerivedCaches(dbDir, denied("thumbnails"));
        expect(onLeaf.failed?.file).toBe(path.join("cache", "thumbnails"));
        expect(fs.existsSync(path.join(dbDir, "cache", "thumbnails", "A.webp"))).toBe(true); // nothing deleted unsafely
    });

    test("a `cache` that is a plain file is skipped, not failed", () => {
        put("cache");
        expect(clearDerivedCaches(dbDir)).toEqual({ removed: 0, skipped: ["cache"] });
    });
});

function defaultOps(): CacheClearOps {
    return {
        inspect: (p) => {
            try {
                const s = fs.lstatSync(p);
                return s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : "other";
            } catch (e: any) {
                if (e?.code === "ENOENT") return "absent";
                throw e;
            }
        },
        readdir: (p) => fs.readdirSync(p),
        remove: (p) => fs.rmSync(p, { recursive: true, force: true })
    };
}

// ---- queued watcher events survive a scan (retry outcomes preserved) ------------

describe("watcher events queued during a scan keep their retry outcomes", () => {
    let fx: LibraryFixture;
    beforeEach(() => { fx = createLibraryFixture(); });
    afterEach(() => { fx.cleanup(); });

    const DEBOUNCE = 500;
    const RETRY = [100, 200, 400];
    const rootMeta = () => path.join(fx.libraryPath, "metadata.json");
    const gate = () => {
        let release!: () => void;
        const promise = new Promise<void>(r => { release = r; });
        return { promise, release };
    };

    /** A scan blocked mid-flight (reading item A), a router in front of the same indexer, and a lock snapshot. */
    function blockedScanSetup(opts: { rejectWhile?: { on: boolean } } = {}) {
        const clock = fakeTimers();
        const snapshot = { folders: [] as any[], tagsGroups: [] as any[], lockedFolderIds: new Set<string>(), lastUpdated: 0 };
        const blocker = gate();
        let blockedOnce = false;
        let reached!: () => void;
        const scanReached = new Promise<void>(r => { reached = r; });
        const indexer = fx.createIndexer({
            onLibraryMetadata: (m) => {
                if (opts.rejectWhile?.on) return false;
                return publishLockSnapshot(snapshot, m).ok;
            },
            fs: {
                readFile: async (p) => {
                    const text = await fs.promises.readFile(p, "utf8");
                    if (!blockedOnce && p === fx.itemMetaPath("A")) {
                        blockedOnce = true;
                        reached();
                        await blocker.promise;
                    }
                    return text;
                }
            }
        });
        const router = createWatcherRouter({
            libraryPath: fx.libraryPath, indexer, invalidateCache: () => { }, timers: clock.timers,
            debounceMs: DEBOUNCE, retryDelaysMs: RETRY
        });
        return { clock, snapshot, blocker, scanReached, indexer, router };
    }

    test("unreadable root + item replays after the scan are retried and apply the completed content without another event", async () => {
        const locked = { folders: [{ id: "F1", name: "F", password: "pw", children: [] }], tagsGroups: [] };
        fx.writeRootMetadata(locked);
        fx.writeItem("A");
        fx.seedRow("B", { name: "Old", last_scanned: 1000 });
        fx.writeItem("B", { name: "Old" });
        const { clock, snapshot, blocker, scanReached, indexer, router } = blockedScanSetup();
        publishLockSnapshot(snapshot, locked);

        const scan = indexer.scan();
        await scanReached;

        // Events arrive mid-scan; the content is only half written when the scan replays them
        fs.writeFileSync(rootMeta(), '{ "folders": [{ "id": "F1", "na');
        fx.writeRawMetadata("B", '{ "name": "Half');
        router.onFileEvent(rootMeta(), "change");
        router.onFileEvent(fx.itemMetaPath("B"), "change");
        await clock.advance(DEBOUNCE);
        expect(clock.size).toBe(0); // both are queued behind the scan: nothing scheduled yet

        blocker.release();
        await scan;
        await settle();

        // Replay failed -> retries scheduled; previous locks and row survive
        expect(clock.size).toBe(2);
        expect(snapshot.lockedFolderIds.has("F1")).toBe(true);
        expect(fx.getRow("B")!.name).toBe("Old");
        expect(fx.getRow("B")!.last_scanned).toBe(0);

        await clock.advance(RETRY[0]); // still incomplete: fails again, still fail-closed
        expect(snapshot.lockedFolderIds.has("F1")).toBe(true);
        expect(clock.size).toBe(2);

        // Writers finish; NO further watcher event
        fx.writeRootMetadata({ folders: [{ id: "F1", name: "F", children: [] }, { id: "F2", name: "G", password: "new", children: [] }], tagsGroups: [] });
        fx.writeItem("B", { name: "Complete" });
        await clock.advance(RETRY[1]);

        expect([...snapshot.lockedFolderIds]).toEqual(["F2"]);
        expect(fx.getRow("B")!.name).toBe("Complete");
        expect(fx.getRow("B")!.last_scanned).toBeGreaterThan(0);
        expect(clock.size).toBe(0);
        router.dispose();
    });

    test("a rejected folder snapshot on replay keeps the old locks across attempts, then the valid one is applied by retry", async () => {
        const locked = { folders: [{ id: "F1", name: "F", password: "pw", children: [] }], tagsGroups: [] };
        fx.writeRootMetadata(locked);
        fx.writeItem("A");
        const toggle = { on: false };
        const { clock, snapshot, blocker, scanReached, indexer, router } = blockedScanSetup({ rejectWhile: toggle });
        publishLockSnapshot(snapshot, locked);

        const scan = indexer.scan();
        await scanReached;
        toggle.on = true; // snapshot validation rejects the replacement
        fx.writeRootMetadata({ folders: [{ id: "F1", name: "F", children: [] }, { id: "F2", name: "G", password: "x", children: [] }], tagsGroups: [] });
        router.onFileEvent(rootMeta(), "change");
        await clock.advance(DEBOUNCE);

        blocker.release();
        await scan;
        await settle();
        expect(clock.size).toBe(1); // replay was 'rejected' -> retry scheduled
        expect(snapshot.lockedFolderIds.has("F1")).toBe(true);

        await clock.advance(RETRY[0]);
        expect(snapshot.lockedFolderIds.has("F1")).toBe(true); // still rejected: previous locks kept
        expect(clock.size).toBe(1);

        toggle.on = false;
        await clock.advance(RETRY[1]);
        expect([...snapshot.lockedFolderIds]).toEqual(["F2"]);
        expect(clock.size).toBe(0);
        router.dispose();
    });

    test("queued event outcomes: every caller of a coalesced item event gets the real replay outcome", async () => {
        fx.writeItem("A");
        fx.writeRawMetadata("B", "{ nope");
        const { blocker, scanReached, indexer } = blockedScanSetup();
        const scan = indexer.scan();
        await scanReached;
        const first = indexer.itemChanged("B");
        const second = indexer.itemChanged("B");
        blocker.release();
        await scan;
        expect(await first).toBe("unreadable");
        expect(await second).toBe("unreadable");
    });
});

// ---- retry attempt ownership ----------------------------------------------------

describe("watcher retry attempt ownership", () => {
    const DEBOUNCE = 500;
    const RETRY = [100, 200];
    const lib = path.join(os.tmpdir(), "lwv-ownership-lib");
    const metaA = path.join(lib, "images", "A.info", "metadata.json");

    type Call = { resolve: (o: "applied" | "unreadable" | "failed") => void };
    function setup(retryDelaysMs = RETRY) {
        const clock = fakeTimers();
        const calls: Call[] = [];
        const errors: unknown[][] = [];
        const router = createWatcherRouter({
            libraryPath: lib,
            indexer: {
                itemChanged: () => new Promise(resolve => { calls.push({ resolve }); }),
                itemRemoved: async () => "applied",
                refreshLibraryMetadata: async () => "applied"
            },
            invalidateCache: () => { },
            logger: { error: (...a: any[]) => { errors.push(a); } },
            timers: clock.timers,
            debounceMs: DEBOUNCE,
            retryDelaysMs
        });
        return { clock, calls, errors, router };
    }

    test("an old unreadable attempt finishing after a newer event neither cancels nor replaces the newer schedule", async () => {
        const { clock, calls, router } = setup();
        router.onFileEvent(metaA, "change");
        await clock.advance(DEBOUNCE);
        expect(calls.length).toBe(1); // attempt in flight

        router.onFileEvent(metaA, "change"); // newer event, debouncing
        calls[0].resolve("unreadable"); // the old attempt finishes now
        await settle();

        await clock.advance(DEBOUNCE - 1); // the old sequence's retry (100ms) would have fired by now
        expect(calls.length).toBe(1);
        await clock.advance(1); // the newer event's debounce fires
        expect(calls.length).toBe(2);

        calls[1].resolve("unreadable"); // the new owner continues ITS sequence
        await settle();
        expect(clock.size).toBe(1);
        await clock.advance(RETRY[0]);
        expect(calls.length).toBe(3);
        calls[2].resolve("applied");
        await settle();
        expect(clock.size).toBe(0);
        router.dispose();
    });

    test("a new event near the old sequence's exhaustion keeps its own debounce; the stale exhaustion is silent", async () => {
        const { clock, calls, errors, router } = setup([100]);
        router.onFileEvent(metaA, "change");
        await clock.advance(DEBOUNCE);
        calls[0].resolve("unreadable");
        await settle();
        await clock.advance(100);
        expect(calls.length).toBe(2); // the last allowed retry is in flight

        router.onFileEvent(metaA, "change");
        calls[1].resolve("unreadable"); // would have been "exhausted" for the old owner
        await settle();
        expect(errors).toEqual([]);
        expect(clock.size).toBe(1); // the newer debounce is intact

        await clock.advance(DEBOUNCE);
        expect(calls.length).toBe(3);
        calls[2].resolve("applied");
        await settle();
        expect(clock.size).toBe(0);
        router.dispose();
    });

    test("directory removal while an attempt is in flight: the attempt can not schedule a retry afterwards", async () => {
        const { clock, calls, router } = setup();
        router.onFileEvent(metaA, "change");
        await clock.advance(DEBOUNCE);
        expect(calls.length).toBe(1);

        router.onDirRemoved(path.join(lib, "images", "A.info"));
        calls[0].resolve("unreadable");
        await settle();

        expect(clock.size).toBe(0);
        await clock.advance(10_000);
        expect(calls.length).toBe(1);
        router.dispose();
    });

    test("disposal while an attempt is in flight: the attempt can not schedule a retry afterwards", async () => {
        const { clock, calls, router } = setup();
        router.onFileEvent(metaA, "change");
        await clock.advance(DEBOUNCE);
        router.dispose();
        calls[0].resolve("unreadable");
        await settle();
        expect(clock.size).toBe(0);
        await clock.advance(10_000);
        expect(calls.length).toBe(1);
    });
});
