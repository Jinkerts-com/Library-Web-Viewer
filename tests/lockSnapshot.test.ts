import { afterEach, describe, expect, test } from "bun:test";
import { authorizeItem, lockedFolderIdsForRequest, type AccessItem } from '../src/lib/itemAccess';
import {
    createLockInitializer, lockStateFromCache, publishLockSnapshot, type LockSnapshotTarget
} from '../src/lib/lockSnapshot';
import { createLibraryFixture, type LibraryFixture } from './helpers/libraryFixture';

// These tests drive the production snapshot seam: a real LibraryIndexer scan
// reads root metadata.json and hands it to publishLockSnapshot (the exact call
// db.ts's onLibraryMetadata makes) against a cache shaped like db.ts's folderCache.

const fixtures: LibraryFixture[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

function freshCache(): LockSnapshotTarget {
    return { folders: [], tagsGroups: [], lockedFolderIds: new Set(), lastUpdated: 0 };
}

function setup() {
    const fx = createLibraryFixture();
    fixtures.push(fx);
    const cache = freshCache();
    const results: string[] = [];
    const indexer = fx.createIndexer({
        onLibraryMetadata: (m) => { const r = publishLockSnapshot(cache, m); results.push(r.ok ? "ok" : r.reason); }
    });
    const items: Record<string, AccessItem> = {
        secret: { id: "secret", name: "s", ext: "png", folders: ["F1"] },
        open: { id: "open", name: "o", ext: "png", folders: [] }
    };
    const deps = { getLockState: () => lockStateFromCache(cache), lookupItem: (id: string) => items[id] ?? null };
    const req = new Request("http://localhost/x");
    const status = (id: string) => { const d = authorizeItem(deps, req, id); return d.ok ? 200 : d.status; };
    const listing = () => lockedFolderIdsForRequest(deps.getLockState(), req); // null => /api/items 503
    return { fx, cache, results, indexer, status, listing };
}

const locked = { folders: [{ id: "F1", password: "pw", children: [{ id: "F2", children: [] }] }], tagsGroups: [] };

describe("root metadata snapshot validation (first load)", () => {
    const invalid: [string, object][] = [
        ["empty object", {}],
        ["folders: null", { folders: null }],
        ["folders: object", { folders: {} }],
        ["children wrong type", { folders: [{ id: "F1", password: "pw", children: "oops" }] }],
        ["nested children wrong type", { folders: [{ id: "F1", children: [{ id: "F2", children: 5 }] }] }],
        ["missing id on locked folder", { folders: [{ password: "pw", children: [] }] }],
        ["empty id on locked folder", { folders: [{ id: "", password: "pw" }] }],
        ["non-string password", { folders: [{ id: "F1", password: 123 }] }],
        ["non-object folder node", { folders: ["F1"] }]
    ];
    for (const [label, meta] of invalid) {
        test(`${label} -> stays unready; listing and media fail closed`, async () => {
            const t = setup();
            t.fx.writeItem("secret", { folders: ["F1"] });
            t.fx.writeItem("open");
            t.fx.writeRootMetadata(meta);
            await t.indexer.scan();
            expect(t.results[0]).not.toBe("ok");
            expect(t.cache.lastUpdated).toBe(0);
            expect(t.cache.lockedFolderIds.size).toBe(0);
            expect(t.listing()).toBeNull();
            expect(t.status("secret")).toBe(503);
            expect(t.status("open")).toBe(503);
        });
    }

    test("valid empty folders: [] -> ready, nothing locked", async () => {
        const t = setup();
        t.fx.writeRootMetadata({ folders: [], tagsGroups: [] });
        await t.indexer.scan();
        expect(t.results).toEqual(["ok"]);
        expect(t.cache.lastUpdated).toBeGreaterThan(0);
        expect([...t.listing()!]).toEqual([]);
        expect(t.status("open")).toBe(200);
        expect(t.status("secret")).toBe(200);
    });

    test("valid locked snapshot locks the subtree", async () => {
        const t = setup();
        t.fx.writeRootMetadata(locked);
        await t.indexer.scan();
        expect([...t.listing()!].sort()).toEqual(["F1", "F2"]);
        expect(t.status("secret")).toBe(404);
        expect(t.status("open")).toBe(200);
    });
});

describe("invalid metadata after a valid snapshot", () => {
    test("old restrictions survive; they are not cleared", async () => {
        const t = setup();
        t.fx.writeRootMetadata(locked);
        await t.indexer.scan();
        const stamp = t.cache.lastUpdated;
        const folders = t.cache.folders;

        for (const bad of [{}, { folders: null }, { folders: [{ password: "x" }] }, { folders: [{ id: "F1", children: 9 }] }]) {
            t.fx.writeRootMetadata(bad);
            await t.indexer.scan();
            expect(t.results.at(-1)).not.toBe("ok");
            expect(t.cache.lastUpdated).toBe(stamp);
            expect(t.cache.folders).toBe(folders);
            expect([...t.listing()!].sort()).toEqual(["F1", "F2"]);
            expect(t.status("secret")).toBe(404);
            expect(t.status("open")).toBe(200);
        }
    });

    test("a later valid snapshot replaces the old one (including a legitimate unlock-all)", async () => {
        const t = setup();
        t.fx.writeRootMetadata(locked);
        await t.indexer.scan();
        t.fx.writeRootMetadata({ folders: [] });
        await t.indexer.scan();
        expect(t.status("secret")).toBe(200);
    });

    test("snapshot is built locally: a failure deep in the tree publishes nothing", () => {
        const cache = freshCache();
        const r = publishLockSnapshot(cache, { folders: [{ id: "A", password: "p" }, { id: "B", children: [{ id: "C", children: "bad" }] }] });
        expect(r.ok).toBe(false);
        expect(cache).toEqual(freshCache());
    });
});

describe("lock-state initialization seam (createLockInitializer)", () => {
    test("overlapping requests coalesce into one attempt", async () => {
        let ready = false, attempts = 0;
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const init = createLockInitializer(() => ready, async () => { attempts++; await gate; ready = true; });
        const calls = [init(), init(), init()];
        release();
        await Promise.all(calls);
        expect(attempts).toBe(1);
        await init(); // ready: no new attempt
        expect(attempts).toBe(1);
    });

    test("a failed attempt does not wedge; later requests retry (no backoff yet, P1.6)", async () => {
        let ready = false, attempts = 0;
        const init = createLockInitializer(() => ready, async () => {
            attempts++;
            if (attempts < 3) throw new Error("scan failed");
            ready = true;
        });
        await expect(init()).resolves.toBeUndefined();
        expect(ready).toBe(false);
        await init(); // sequential request while unready triggers another attempt
        expect(attempts).toBe(2);
        await init();
        expect(attempts).toBe(3);
        expect(ready).toBe(true);
    });

    test("synchronously throwing attempt is contained; disabled initializer never attempts", async () => {
        let attempts = 0;
        const throwing = createLockInitializer(() => false, () => { attempts++; throw new Error("sync"); });
        await expect(throwing()).resolves.toBeUndefined();
        await throwing();
        expect(attempts).toBe(2);
        const disabled = createLockInitializer(() => false, async () => { attempts++; }, () => false);
        await disabled();
        expect(attempts).toBe(2);
    });
});
