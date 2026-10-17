import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from 'fs';
import path from 'path';
import { itemIdFromDirName } from '../src/lib/scan';
import { createLibraryFixture, type LibraryFixture } from './helpers/libraryFixture';

// The workspace database must never be created/touched by importing the scanner
const workspaceDbPath = path.join(process.cwd(), "db", "library.db");
const workspaceDbBefore = fs.existsSync(workspaceDbPath) ? fs.statSync(workspaceDbPath).mtimeMs : null;

let fx: LibraryFixture;

beforeEach(() => {
    fx = createLibraryFixture();
});

afterEach(() => {
    fx.cleanup();
});

describe("isolation", () => {
    test("importing and running the scanner leaves the workspace database alone", async () => {
        fx.writeItem("AAA");
        await fx.createIndexer().scan();

        const after = fs.existsSync(workspaceDbPath) ? fs.statSync(workspaceDbPath).mtimeMs : null;
        expect(after).toBe(workspaceDbBefore);
    });
});

describe("basic scan", () => {
    test("indexes items, reports sane counts, and skips unchanged items on rescan", async () => {
        fx.writeRootMetadata({ folders: [{ id: "F1", name: "F", children: [] }], tagsGroups: [] });
        fx.writeItem("AAA", { name: "Alpha", tags: ["x", "y"], annotation: "note", star: 3, isDeleted: true });
        fx.writeItem("BBB", { name: "Beta" });
        fx.writeItem("CCC");
        // Non-item entries are ignored
        fs.mkdirSync(path.join(fx.imagesDir, "not-an-item"));

        const future = Date.now() + 60_000;
        const indexer = fx.createIndexer({ now: () => future });
        const result = await indexer.scan();

        expect(result.status).toBe("complete");
        expect(result.total).toBe(3);
        expect(result.upserts).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.removed).toBe(0);
        expect(result.failures).toEqual([]);
        expect(fx.rowIds()).toEqual(["AAA", "BBB", "CCC"]);
        expect(fx.libraryMetadata.length).toBe(1);
        expect(fx.progress.at(-1)).toEqual({ scannedCount: 3, total: 3 });
        expect(indexer.isScanning).toBe(false);

        const a = fx.getRow("AAA")!;
        expect(a.name).toBe("Alpha");
        expect(JSON.parse(a.tags)).toEqual(["x", "y"]);
        expect(a.description).toBe("note");
        expect(a.star).toBe(3);
        expect(a.isDeleted).toBe(1);
        expect(a.last_scanned).toBe(future);

        const again = await fx.createIndexer({ now: () => future + 1 }).scan();
        expect(again.status).toBe("complete");
        expect(again.upserts).toBe(0);
        expect(again.skipped).toBe(3);
        expect(fx.rowIds()).toEqual(["AAA", "BBB", "CCC"]);
    });
});

describe("unreadable item metadata", () => {
    test("preserves the row, records the failure, and re-indexes once readable", async () => {
        fx.seedRow("BAD", { name: "Old name", last_scanned: 1000 });
        fx.cache.add("BAD");
        fx.writeItem("GOOD");
        fx.writeRawMetadata("BAD", "{ this is not json");

        const first = await fx.createIndexer().scan();

        expect(first.status).toBe("partial");
        expect(first.failures.map(f => f.id)).toEqual(["BAD"]);
        expect(first.removed).toBe(0);
        expect(fx.rowIds()).toEqual(["BAD", "GOOD"]);
        const preserved = fx.getRow("BAD")!;
        expect(preserved.name).toBe("Old name");
        // Retry eligibility: the marker is reset so any mtime qualifies
        expect(preserved.last_scanned).toBe(0);
        expect(fx.cache.has("BAD")).toBe(true);

        fx.writeItem("BAD", { name: "Recovered" });
        const second = await fx.createIndexer().scan();

        expect(second.status).toBe("complete");
        expect(second.failures).toEqual([]);
        const recovered = fx.getRow("BAD")!;
        expect(recovered.name).toBe("Recovered");
        expect(recovered.last_scanned).toBeGreaterThan(1000);
    });

    test("injected read failure (not file content) is also preserved and retried", async () => {
        fx.seedRow("NAS", { name: "Seeded", last_scanned: 1000 });
        fx.writeItem("NAS", { name: "On disk" });
        let failing = true;
        const indexer = fx.createIndexer({
            fs: {
                readFile: async (p) => {
                    if (failing && p === fx.itemMetaPath("NAS")) throw new Error("EIO: transient network error");
                    return fs.promises.readFile(p, "utf8");
                }
            }
        });

        const first = await indexer.scan();
        expect(first.status).toBe("partial");
        expect(first.failures).toEqual([{ id: "NAS", error: "EIO: transient network error" }]);
        expect(fx.getRow("NAS")!.name).toBe("Seeded");
        expect(fx.getRow("NAS")!.last_scanned).toBe(0);

        failing = false;
        const second = await indexer.scan();
        expect(second.status).toBe("complete");
        expect(fx.getRow("NAS")!.name).toBe("On disk");
    });

    test("a present .info directory with no metadata.json is a failure, not a removal", async () => {
        fx.seedRow("EMPTY", { last_scanned: 1000 });
        fs.mkdirSync(path.join(fx.imagesDir, "EMPTY.info"));

        const result = await fx.createIndexer().scan();

        expect(result.status).toBe("partial");
        expect(result.failures.map(f => f.id)).toEqual(["EMPTY"]);
        expect(fx.rowIds()).toEqual(["EMPTY"]);
    });
});

describe("failed root enumeration", () => {
    test("missing images directory: no cleanup, reported as failed", async () => {
        fx.seedRow("KEEP1");
        fx.seedRow("KEEP2");
        fx.cache.add("KEEP1");
        fs.rmSync(fx.imagesDir, { recursive: true, force: true });

        const result = await fx.createIndexer().scan();

        expect(result.status).toBe("failed");
        expect(result.error).toContain("Images directory not found");
        expect(result.removed).toBe(0);
        expect(fx.rowIds()).toEqual(["KEEP1", "KEEP2"]);
        expect(fx.invalidated).toEqual([]);
        expect(fx.cache.has("KEEP1")).toBe(true);
    });

    test("readdir failure on an existing images directory: no cleanup, reported as failed", async () => {
        fx.seedRow("KEEP1");
        fx.writeItem("OTHER");
        const result = await fx.createIndexer({
            fs: { readdir: async () => { throw new Error("EIO: listing failed"); } }
        }).scan();

        expect(result.status).toBe("failed");
        expect(result.error).toContain("EIO: listing failed");
        expect(fx.rowIds()).toEqual(["KEEP1"]);
        expect(fx.invalidated).toEqual([]);
    });
});

describe("genuine removal", () => {
    test("deletes the row and cache entry for an absent .info directory only", async () => {
        fx.writeItem("STAY");
        fx.writeItem("GONE");
        const first = await fx.createIndexer().scan();
        expect(first.status).toBe("complete");
        fx.cache.add("GONE");
        fx.cache.add("STAY");

        fx.removeItem("GONE");
        const second = await fx.createIndexer().scan();

        expect(second.status).toBe("complete");
        expect(second.removed).toBe(1);
        expect(fx.rowIds()).toEqual(["STAY"]);
        expect(fx.cache.has("GONE")).toBe(false);
        expect(fx.cache.has("STAY")).toBe(true);
    });
});

describe("mixed scan", () => {
    test("additions, removals and one unreadable item in a single pass", async () => {
        fx.seedRow("OLD1", { last_scanned: 1000 });
        fx.seedRow("OLD2", { last_scanned: 1000 }); // directory gone -> removed
        fx.seedRow("BROKEN", { name: "Before", last_scanned: 1000 });
        fx.writeItem("OLD1", { name: "Updated" });
        fx.writeRawMetadata("BROKEN", "");
        fx.writeItem("NEW1");
        fx.writeItem("NEW2");
        fx.cache.add("OLD2");
        fx.cache.add("BROKEN");

        const result = await fx.createIndexer().scan();

        expect(result.status).toBe("partial");
        expect(result.total).toBe(4);
        expect(result.upserts).toBe(3);
        expect(result.removed).toBe(1);
        expect(result.failures.map(f => f.id)).toEqual(["BROKEN"]);
        expect(fx.rowIds()).toEqual(["BROKEN", "NEW1", "NEW2", "OLD1"]);
        expect(fx.getRow("OLD1")!.name).toBe("Updated");
        expect(fx.getRow("BROKEN")!.name).toBe("Before");
        expect(fx.cache.has("OLD2")).toBe(false);
        expect(fx.cache.has("BROKEN")).toBe(true);
    });
});

describe("scan / watcher serialization", () => {
    test("an update arriving mid-scan is not overwritten by the stale snapshot", async () => {
        fx.writeItem("A", { name: "Old" });
        let fired = false;
        const indexer = fx.createIndexer({
            fs: {
                readFile: async (p) => {
                    const text = await fs.promises.readFile(p, "utf8");
                    if (!fired && p === fx.itemMetaPath("A")) {
                        fired = true;
                        // The file changes after the scan read it, and the watcher reports it
                        fx.writeItem("A", { name: "New" });
                        void indexer.itemChanged("A");
                    }
                    return text;
                }
            }
        });

        const result = await indexer.scan();

        expect(result.status).toBe("complete");
        expect(fired).toBe(true);
        expect(fx.getRow("A")!.name).toBe("New");
    });

    test("an item removed mid-scan is removed after the scan, not resurrected", async () => {
        fx.writeItem("A");
        fx.writeItem("B");
        let fired = false;
        const indexer = fx.createIndexer({
            fs: {
                readFile: async (p) => {
                    const text = await fs.promises.readFile(p, "utf8");
                    if (!fired && p === fx.itemMetaPath("A")) {
                        fired = true;
                        fx.removeItem("A");
                        void indexer.itemRemoved("A");
                    }
                    return text;
                }
            }
        });

        await indexer.scan();

        expect(fx.rowIds()).toEqual(["B"]);
    });

    test("an item added mid-scan is indexed by the replay", async () => {
        fx.writeItem("A");
        let fired = false;
        const indexer = fx.createIndexer({
            fs: {
                readFile: async (p) => {
                    const text = await fs.promises.readFile(p, "utf8");
                    if (!fired) {
                        fired = true;
                        fx.writeItem("LATE", { name: "Late" });
                        void indexer.itemChanged("LATE");
                    }
                    return text;
                }
            }
        });

        await indexer.scan();

        expect(fx.rowIds()).toEqual(["A", "LATE"]);
        expect(fx.getRow("LATE")!.name).toBe("Late");
    });

    test("watcher events outside a scan apply, and unreadable ones keep the existing row", async () => {
        const indexer = fx.createIndexer();
        fx.writeItem("W", { name: "v1" });
        await indexer.itemChanged("W");
        expect(fx.getRow("W")!.name).toBe("v1");

        fx.writeRawMetadata("W", "garbage");
        await indexer.itemChanged("W");
        expect(fx.getRow("W")!.name).toBe("v1");

        await indexer.itemRemoved("W");
        expect(fx.getRow("W")).toBeNull();
        expect(fx.indexChanged.count).toBeGreaterThan(0);
    });
});

describe("upsert semantics", () => {
    test("scan and watcher updates preserve unknown pre-existing columns (no REPLACE)", async () => {
        fx.db.run("ALTER TABLE items ADD COLUMN custom_note TEXT");
        fx.seedRow("X", { name: "Before", last_scanned: 1000, custom_note: "keep me" } as any);
        fx.writeItem("X", { name: "After" });
        const indexer = fx.createIndexer();

        await indexer.scan();
        expect(fx.getRow("X")!.name).toBe("After");
        expect(fx.getRow("X")!.custom_note).toBe("keep me");

        fx.writeItem("X", { name: "After watcher" });
        await indexer.itemChanged("X");
        expect(fx.getRow("X")!.name).toBe("After watcher");
        expect(fx.getRow("X")!.custom_note).toBe("keep me");
    });
});

describe("id extraction", () => {
    test("removes only the trailing .info suffix", () => {
        expect(itemIdFromDirName("ABC.info")).toBe("ABC");
        expect(itemIdFromDirName("my.info.photo.info")).toBe("my.info.photo");
        expect(itemIdFromDirName(".info.info")).toBe(".info");
        expect(itemIdFromDirName("ABC")).toBeNull();
        expect(itemIdFromDirName("ABC.info.bak")).toBeNull();
    });

    test("an id containing '.info' is indexed, kept, removed by scan and by watcher unlink", async () => {
        fx.writeItem("my.info.photo");
        fx.writeItem("other");
        const indexer = fx.createIndexer();

        await indexer.scan();
        expect(fx.rowIds()).toEqual(["my.info.photo", "other"]);

        // Unlink path uses the same id derivation
        await indexer.itemRemoved(itemIdFromDirName("my.info.photo.info")!);
        expect(fx.rowIds()).toEqual(["other"]);

        fx.writeItem("my.info.photo");
        await indexer.scan();
        fx.removeItem("my.info.photo");
        const result = await indexer.scan();
        expect(result.removed).toBe(1);
        expect(fx.rowIds()).toEqual(["other"]);
    });
});
