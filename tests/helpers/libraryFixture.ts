import { Database } from "bun:sqlite";
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureSchema } from '../../src/lib/schema';
import { LibraryIndexer, type IndexerDeps, type ScanFs } from '../../src/lib/scan';

/**
 * Temporary Eagle-style library + SQLite database for tests. Everything lives
 * under an OS temp dir; nothing here reads the environment or the workspace db/.
 */
export interface LibraryFixture {
    root: string;
    libraryPath: string;
    imagesDir: string;
    db: Database;
    /** Stand-in for the thumbnail/preview cache: ids with a cached file. */
    cache: Set<string>;
    invalidated: string[];
    progress: { scannedCount: number; total: number }[];
    libraryMetadata: any[];
    indexChanged: { count: number };
    writeRootMetadata(meta?: object): void;
    writeItem(id: string, overrides?: Partial<ItemMeta>): ItemMeta;
    writeRawMetadata(id: string, raw: string): void;
    removeItem(id: string): void;
    itemMetaPath(id: string): string;
    seedRow(id: string, columns?: Record<string, unknown>): void;
    getRow(id: string): Record<string, any> | null;
    rowIds(): string[];
    createIndexer(overrides?: Partial<IndexerDeps> & { fs?: Partial<ScanFs> }): LibraryIndexer;
    cleanup(): void;
}

export interface ItemMeta {
    id: string;
    name: string;
    ext: string;
    size: number;
    modificationTime: number;
    btime: number;
    width: number;
    height: number;
    tags: string[];
    folders: string[];
    annotation: string;
    palettes: unknown[];
    star: number;
    duration: number;
    isDeleted: boolean;
}

export function createLibraryFixture(): LibraryFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lwv-test-"));
    const libraryPath = path.join(root, "Library.library");
    const imagesDir = path.join(libraryPath, "images");
    fs.mkdirSync(imagesDir, { recursive: true });

    const db = new Database(path.join(root, "test.db"), { create: true });
    ensureSchema(db);

    const indexers: LibraryIndexer[] = [];

    const fixture: LibraryFixture = {
        root,
        libraryPath,
        imagesDir,
        db,
        cache: new Set(),
        invalidated: [],
        progress: [],
        libraryMetadata: [],
        indexChanged: { count: 0 },

        writeRootMetadata(meta = { folders: [], tagsGroups: [] }) {
            fs.writeFileSync(path.join(libraryPath, "metadata.json"), JSON.stringify(meta));
        },

        writeItem(id, overrides = {}) {
            const meta: ItemMeta = {
                id,
                name: `Item ${id}`,
                ext: "png",
                size: 1234,
                modificationTime: 1_700_000_000_000,
                btime: 1_700_000_000_000,
                width: 10,
                height: 20,
                tags: ["tag-a"],
                folders: [],
                annotation: "",
                palettes: [],
                star: 0,
                duration: 0,
                isDeleted: false,
                ...overrides
            };
            const dir = path.join(imagesDir, `${id}.info`);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta));
            return meta;
        },

        writeRawMetadata(id, raw) {
            const dir = path.join(imagesDir, `${id}.info`);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "metadata.json"), raw);
        },

        removeItem(id) {
            fs.rmSync(path.join(imagesDir, `${id}.info`), { recursive: true, force: true });
        },

        itemMetaPath(id) {
            return path.join(imagesDir, `${id}.info`, "metadata.json");
        },

        seedRow(id, columns = {}) {
            const row: Record<string, unknown> = {
                id, name: `Seeded ${id}`, ext: "png", size: 1, modificationTime: 1, btime: 1,
                width: 1, height: 1, tags: "[]", folders: "[]", description: "", palettes: "[]",
                star: 0, duration: 0, isDeleted: 0, last_scanned: 1000,
                ...columns
            };
            const keys = Object.keys(row);
            db.query(`INSERT INTO items (${keys.join(", ")}) VALUES (${keys.map(k => "$" + k).join(", ")})`)
                .run(Object.fromEntries(keys.map(k => ["$" + k, row[k]])) as any);
        },

        getRow(id) {
            return (db.query("SELECT * FROM items WHERE id = ?").get(id) as Record<string, any> | null) ?? null;
        },

        rowIds() {
            return (db.query("SELECT id FROM items ORDER BY id").all() as { id: string }[]).map(r => r.id);
        },

        createIndexer(overrides = {}) {
            const indexer = new LibraryIndexer({
                db,
                libraryPath,
                invalidateCache: (id) => {
                    fixture.invalidated.push(id);
                    fixture.cache.delete(id);
                },
                onProgress: (p) => fixture.progress.push(p),
                onLibraryMetadata: (m) => fixture.libraryMetadata.push(m),
                onIndexChanged: () => { fixture.indexChanged.count++; },
                ...overrides
            });
            indexers.push(indexer);
            return indexer;
        },

        cleanup() {
            indexers.forEach(i => i.dispose());
            db.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    };

    return fixture;
}
