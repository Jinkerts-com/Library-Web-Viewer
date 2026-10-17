import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureSchema } from '../src/lib/schema';
import { createLibraryFixture, type LibraryFixture } from './helpers/libraryFixture';

let fx: LibraryFixture;

beforeEach(() => {
    fx = createLibraryFixture();
});

afterEach(() => {
    fx.cleanup();
});

const settle = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls until `cond` holds; fails loudly (never hangs) after `timeoutMs`. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
        await new Promise<void>((r) => setTimeout(r, 2));
    }
}

/** Makes metadata.json look older (mtimeMs = 50) than any realistic last_scanned marker. */
function makeOld(id: string) {
    fs.utimesSync(fx.itemMetaPath(id), 0.05, 0.05);
}

describe("scan -> watcher handoff", () => {
    test("a single event landing at any microtask offset around the final replay is applied without another scan", async () => {
        for (let d = 0; d < 10; d++) {
            const local = createLibraryFixture();
            try {
                local.writeItem("A");
                local.writeItem("TRIGGER", { name: "v1" });
                let firstTriggerRead = true;
                // The replay of TRIGGER logs synchronously right before it returns to the drain
                // loop; exactly one event is fired d microtasks later so it can land on either
                // side of the final empty-queue check / release (the queue is empty at that check).
                const indexer = local.createIndexer({
                    logger: {
                        info: (...args: any[]) => {
                            if (String(args[0]).startsWith("[WATCHER] Updated item: TRIGGER")) {
                                void (async () => {
                                    for (let i = 0; i < d; i++) await Promise.resolve();
                                    // Only appears on disk now, so only the watcher path can index it
                                    local.writeItem("LATE", { name: `late ${d}` });
                                    void indexer.itemChanged("LATE");
                                })();
                            }
                        },
                        error() { },
                        verbose() { }
                    },
                    fs: {
                        readFile: async (p) => {
                            const text = await fs.promises.readFile(p, "utf8");
                            if (firstTriggerRead && p === local.itemMetaPath("TRIGGER")) {
                                firstTriggerRead = false;
                                void indexer.itemChanged("TRIGGER");
                            }
                            return text;
                        }
                    }
                });

                const result = await indexer.scan();
                // Bounded condition wait instead of a fixed sleep: slow CI can only delay, never flake
                await waitFor(() => local.getRow("LATE")?.name === `late ${d}`, `LATE to be applied at offset ${d}`);

                expect(result.status).toBe("complete");
                expect(indexer.isScanning).toBe(false);
                expect(`offset ${d}: ${local.getRow("LATE")?.name}`).toBe(`offset ${d}: late ${d}`);
            } finally {
                local.cleanup();
            }
        }
    });
    test("events arriving while replay awaits metadata are drained", async () => {
        fx.writeItem("A");
        fx.writeItem("FIRST", { name: "first" });

        let firstReads = 0;
        const indexer = fx.createIndexer({
            fs: {
                readFile: async (p) => {
                    if (p === fx.itemMetaPath("FIRST")) {
                        firstReads++;
                        if (firstReads === 1) void indexer.itemChanged("FIRST");
                        else {
                            // Replay of FIRST is in progress. SECOND only comes into existence now,
                            // so its row can exist solely if this late event is drained and applied.
                            fx.writeItem("SECOND", { name: "second-late" });
                            void indexer.itemChanged("SECOND");
                            await settle(10);
                        }
                    }
                    return fs.promises.readFile(p, "utf8");
                }
            }
        });
        fx.db.run("DELETE FROM items");

        await indexer.scan();

        expect(firstReads).toBe(2);
        expect(fx.getRow("SECOND")?.name).toBe("second-late");
        expect(indexer.isScanning).toBe(false);
    });

    test("same-id conflicting events keep last-event-wins semantics", async () => {
        fx.writeItem("A");
        fx.writeItem("KEEP", { name: "keep" });
        fx.writeItem("DROP", { name: "drop" });
        const indexer = fx.createIndexer({
            fs: {
                readFile: async (p) => {
                    const text = await fs.promises.readFile(p, "utf8");
                    if (p === fx.itemMetaPath("A")) {
                        // remove then change -> present; change then remove -> absent
                        void indexer.itemRemoved("KEEP");
                        void indexer.itemChanged("KEEP");
                        void indexer.itemChanged("DROP");
                        void indexer.itemRemoved("DROP");
                    }
                    return text;
                }
            }
        });
        // Scan would index KEEP/DROP itself; seed them as stale to prove the replay decides
        await indexer.scan();

        expect(fx.getRow("KEEP")?.name).toBe("keep");
        expect(fx.getRow("DROP")).toBeNull();
    });

    test("a failed mutation does not stop later queued mutations", async () => {
        fx.writeItem("A");
        fx.writeItem("BOOM");
        fx.writeItem("OK", { name: "ok" });
        let armed = false;
        const indexer = fx.createIndexer({
            invalidateCache: (id) => {
                if (armed && id === "BOOM") throw new Error("cache invalidation exploded");
            },
            fs: {
                readFile: async (p) => {
                    const text = await fs.promises.readFile(p, "utf8");
                    if (p === fx.itemMetaPath("A")) {
                        armed = true;
                        void indexer.itemChanged("BOOM");
                        void indexer.itemChanged("OK");
                    }
                    return text;
                }
            }
        });
        fx.db.run("DELETE FROM items");
        fx.db.run("INSERT INTO items (id, name, last_scanned) VALUES ('OK', 'stale', 1)");

        await indexer.scan();

        expect(fx.getRow("OK")?.name).toBe("ok");
        expect(indexer.isScanning).toBe(false);
    });

    test("a logger that throws can neither strand the scan state nor abort replay", async () => {
        fx.writeItem("A");
        fx.writeItem("OK", { name: "ok" });
        let armed = false;
        const throwing = (..._args: any[]) => { throw new Error("logger exploded"); };
        const indexer = fx.createIndexer({
            logger: { info: throwing, error: throwing, verbose: throwing },
            // The failing replay is reported through the throwing logger, from inside drainAndRelease
            invalidateCache: (id) => { if (armed && id === "BOOM") throw new Error("cache invalidation exploded"); },
            fs: {
                readFile: async (p) => {
                    const text = await fs.promises.readFile(p, "utf8");
                    if (p === fx.itemMetaPath("A")) {
                        armed = true;
                        fx.writeItem("BOOM"); // appears after the inventory, so only the replay touches it
                        void indexer.itemChanged("BOOM");
                        void indexer.itemChanged("OK");
                    }
                    return text;
                }
            }
        });
        fx.db.run("DELETE FROM items");
        fx.db.run("INSERT INTO items (id, name, last_scanned) VALUES ('OK', 'stale', 1)");

        const result = await indexer.scan();

        expect(result.status).toBe("complete");
        expect(indexer.isScanning).toBe(false);
        expect(fx.getRow("OK")?.name).toBe("ok"); // replay continued past the failing id
        armed = false;
        expect((await indexer.scan()).status).not.toBe("busy"); // ownership really was released
    });

    test("a failed watcher mutation outside a scan does not block the next one", async () => {
        fx.writeItem("BOOM");
        fx.writeItem("OK", { name: "ok" });
        const indexer = fx.createIndexer({
            invalidateCache: (id) => { if (id === "BOOM") throw new Error("nope"); }
        });

        await indexer.itemChanged("BOOM");
        await indexer.itemChanged("OK");

        expect(fx.getRow("OK")?.name).toBe("ok");
        expect(fx.getRow("BOOM")).toBeNull();
    });

    test("a scan waits for a genuinely in-flight watcher mutation", async () => {
        fx.writeItem("W", { name: "watched" });
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const log: string[] = [];
        let gated = true;
        const indexer = fx.createIndexer({
            fs: {
                readFile: async (p) => {
                    if (gated && p === fx.itemMetaPath("W")) {
                        gated = false;
                        log.push("mutation-read-start");
                        await gate;
                    }
                    return fs.promises.readFile(p, "utf8");
                },
                readdir: async (p) => {
                    log.push(`scan-readdir(W indexed: ${fx.getRow("W") !== null})`);
                    return fs.promises.readdir(p);
                }
            }
        });

        const mutation = indexer.itemChanged("W");
        await settle(5);
        const scan = indexer.scan();
        await settle(25);
        expect(log).toEqual(["mutation-read-start"]);

        release();
        await mutation;
        const result = await scan;

        expect(result.status).toBe("complete");
        expect(log).toEqual(["mutation-read-start", "scan-readdir(W indexed: true)"]);
    });
});

describe("retry eligibility of failed items", () => {
    test("failed stat, then recovery with mtime older than the previous marker -> re-indexed", async () => {
        fx.db.run("ALTER TABLE items ADD COLUMN custom_note TEXT");
        fx.seedRow("S", { name: "Indexed", last_scanned: 100, custom_note: "keep" } as any);
        fx.cache.add("S");
        fx.writeItem("S", { name: "New content" });
        makeOld("S");
        let failing = true;
        const indexer = fx.createIndexer({
            fs: {
                stat: async (p) => {
                    if (failing && p === fx.itemMetaPath("S")) throw new Error("EIO: stat failed");
                    return fs.promises.stat(p);
                }
            }
        });

        const first = await indexer.scan();
        expect(first.status).toBe("partial");
        const mid = fx.getRow("S")!;
        expect(mid.name).toBe("Indexed");
        expect(mid.custom_note).toBe("keep");
        expect(mid.last_scanned).toBe(0);
        expect(fx.cache.has("S")).toBe(true);

        failing = false;
        const second = await indexer.scan();
        expect(second.upserts).toBe(1);
        expect(second.skipped).toBe(0);
        const after = fx.getRow("S")!;
        expect(after.name).toBe("New content");
        expect(after.custom_note).toBe("keep");
    });

    test("failed watcher read, then scan with an older/preserved mtime -> re-indexed", async () => {
        fx.seedRow("W", { name: "Indexed", last_scanned: 100 });
        fx.cache.add("W");
        fx.writeRawMetadata("W", "garbage");
        const indexer = fx.createIndexer();

        await indexer.itemChanged("W");
        const mid = fx.getRow("W")!;
        expect(mid.name).toBe("Indexed");
        expect(mid.last_scanned).toBe(0);
        expect(fx.cache.has("W")).toBe(true);

        fx.writeItem("W", { name: "Recovered" });
        makeOld("W");
        const result = await indexer.scan();

        expect(result.upserts).toBe(1);
        expect(fx.getRow("W")!.name).toBe("Recovered");
    });
});

describe("transaction failures", () => {
    test("a failing batch rolls back, earlier batches stay, and counters do not drift", async () => {
        for (const id of ["A", "B", "C"]) fx.writeItem(id);
        const indexer = fx.createIndexer({
            batchSize: 1,
            invalidateCache: (id) => { if (id === "B") throw new Error("batch boom"); }
        });

        const result = await indexer.scan();

        expect(result.status).toBe("failed");
        expect(result.error).toContain("batch boom");
        expect(result.upserts).toBe(1);
        expect(result.scanned).toBe(1);
        expect(fx.rowIds()).toEqual(["A"]);
        expect(indexer.isScanning).toBe(false);
    });

    test("a rolled-back cleanup does not report deletions", async () => {
        fx.seedRow("GONE1");
        fx.seedRow("GONE2");
        fx.writeItem("KEEP");
        const indexer = fx.createIndexer({
            invalidateCache: (id) => { if (id === "GONE2") throw new Error("cleanup boom"); }
        });

        const result = await indexer.scan();

        expect(result.status).toBe("failed");
        expect(result.removed).toBe(0);
        expect(fx.rowIds()).toEqual(["GONE1", "GONE2", "KEEP"]);
    });

    test("a rollback failure preserves both diagnostics", async () => {
        fx.writeItem("A");
        const indexer = fx.createIndexer({
            invalidateCache: () => {
                fx.db.run("ROLLBACK"); // transaction vanishes, so the indexer's own ROLLBACK fails
                throw new Error("original failure");
            }
        });

        const result = await indexer.scan();

        expect(result.status).toBe("failed");
        expect(result.error).toContain("original failure");
        expect(result.error).toContain("rollback also failed");
    });

    test("the rollback error keeps the original failure as `cause`", () => {
        const indexer = fx.createIndexer();
        const original = new Error("original failure");

        let thrown: any;
        try {
            (indexer as any).inTransaction(() => {
                fx.db.run("ROLLBACK");
                throw original;
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.cause).toBe(original);
        expect(thrown.message).toContain("original failure");
        expect(thrown.message).toContain("rollback also failed");
    });

    test("a committed cleanup keeps its removed count when the post-cleanup hook fails (replay failure: see the throwing-logger test above)", async () => {
        fx.seedRow("GONE");
        fx.writeItem("KEEP");
        const indexer = fx.createIndexer({
            onIndexChanged: () => { throw new Error("hook exploded"); }
        });

        const result = await indexer.scan();

        expect(result.removed).toBe(1);
        expect(fx.rowIds()).toEqual(["KEEP"]);
        expect(result.status).toBe("complete"); // a throwing hook cannot retroactively fail committed work
        expect(indexer.isScanning).toBe(false);
    });

    test("a scan that fails after earlier batches committed reports only what really committed", async () => {
        fx.seedRow("GONE");
        for (const id of ["A", "B"]) fx.writeItem(id);
        const indexer = fx.createIndexer({
            batchSize: 1,
            invalidateCache: (id) => { if (id === "B") throw new Error("batch boom"); }
        });

        const result = await indexer.scan();

        expect(result.status).toBe("failed");
        expect(result.upserts).toBe(1);
        expect(result.removed).toBe(0); // cleanup never ran, so GONE is still indexed
        expect(fx.rowIds()).toEqual(["A", "GONE"]);
    });
});

describe("existing-database migration", () => {
    test("old-schema database is migrated additively and forced to rescan", async () => {
        const oldDbPath = path.join(fx.root, "old.db");
        const old = new Database(oldDbPath, { create: true });
        old.run(`CREATE TABLE items (
            id TEXT PRIMARY KEY, name TEXT, ext TEXT, size INTEGER,
            modificationTime INTEGER, width INTEGER, height INTEGER, tags TEXT, folders TEXT,
            last_scanned INTEGER, custom_note TEXT)`);
        old.run(`INSERT INTO items (id, name, tags, folders, last_scanned, custom_note)
                 VALUES ('X', 'Old X', '["t"]', '[]', 9999999999999, 'mine')`);

        ensureSchema(old);

        const cols = (old.query("PRAGMA table_info(items)").all() as { name: string }[]).map(c => c.name);
        for (const c of ["description", "palettes", "btime", "star", "duration", "isDeleted", "custom_note"]) {
            expect(cols).toContain(c);
        }
        let row = old.query("SELECT * FROM items WHERE id = 'X'").get() as any;
        expect(row.name).toBe("Old X");
        expect(row.custom_note).toBe("mine");
        expect(row.last_scanned).toBe(0);

        // Genuinely close and reopen the migrated file: it must not force another rescan
        old.run("UPDATE items SET last_scanned = 77");
        old.close();
        const reopened = new Database(oldDbPath);
        ensureSchema(reopened);
        row = reopened.query("SELECT last_scanned FROM items WHERE id = 'X'").get() as any;
        expect(row.last_scanned).toBe(77);
        reopened.run("UPDATE items SET last_scanned = 0");

        // The migrated row is re-read by a scan and unknown columns survive
        const { LibraryIndexer } = await import("../src/lib/scan");
        fx.writeItem("X", { name: "Fresh X" });
        const indexer = new LibraryIndexer({ db: reopened, libraryPath: fx.libraryPath, invalidateCache: () => { } });
        const result = await indexer.scan();
        expect(result.upserts).toBe(1);
        row = reopened.query("SELECT * FROM items WHERE id = 'X'").get() as any;
        expect(row.name).toBe("Fresh X");
        expect(row.custom_note).toBe("mine");
        indexer.dispose();
        reopened.close();
    });
});

describe("import isolation", () => {
    test("importing scan.ts in a fresh process creates no db/library.db", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lwv-import-"));
        try {
            const scanPath = path.resolve(import.meta.dir, "../src/lib/scan.ts");
            const proc = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(scanPath)});`], { cwd });
            expect(proc.exitCode).toBe(0);
            expect(fs.existsSync(path.join(cwd, "db"))).toBe(false);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
});
