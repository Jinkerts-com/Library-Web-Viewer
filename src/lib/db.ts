/// <reference types="bun" />
import { Database } from "bun:sqlite";
import fs from 'fs';
import path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { deleteItemCache } from './thumbnailUtils';

export const scanEmitter = new EventEmitter();

export interface Folder {
    id: string;
    name: string;
    description: string;
    children: Folder[];
    modificationTime: number;
    tags: string[];
    password?: string;
    [key: string]: any;
}

export interface TagGroup {
    id?: string;
    name: string;
    tags: string[];
    color?: string;
}

export interface FolderCache {
    folders: Folder[];
    lockedFolderIds: Set<string>;
    allTags: string[];
    tagCounts: Record<string, number>;
    tagsGroups: TagGroup[];
    lastUpdated: number;
}

const isVerbose = process.env.VERBOSE === 'true';
function verboseLog(...args: any[]) {
    if (isVerbose) {
        console.log('[VERBOSE]', ...args);
    }
}

export let libraryPath: string = "";

const libPathEnv = process.env.LIBRARY_PATH;
if (libPathEnv) {
    libraryPath = path.normalize(libPathEnv);
    verboseLog("Loaded configuration from environment. Library Path:", libraryPath);
} else {
    console.error("LIBRARY_PATH environment variable is not set. Please create a .env file or export it.");
    console.warn("Continuing with an empty library path, but scans and images will not work correctly.");
}

const rootDir = process.cwd();

const dbPath = path.join(rootDir, "db", "library.db");
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    verboseLog("Creating DB directory at", dbDir);
    fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath, { create: true });
verboseLog("Database handle created at", dbPath);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 3000;");

export function initDB() {
    console.log("Initializing DB at", dbPath);
    verboseLog("Running CREATE TABLE IF NOT EXISTS items...");

    db.run(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT,
      ext TEXT,
      size INTEGER,
      modificationTime INTEGER,
      btime INTEGER,
      width INTEGER,
      height INTEGER,
      tags TEXT,
      folders TEXT,
      description TEXT,
      palettes TEXT,
      star INTEGER,
      duration REAL,
      isDeleted INTEGER,
      last_scanned INTEGER
    )`);

    try {
        db.run("ALTER TABLE items ADD COLUMN description TEXT");
        verboseLog("Migration: Added 'description' column.");
    } catch (e) {
    }

    try {
        db.run("ALTER TABLE items ADD COLUMN palettes TEXT");
        verboseLog("Migration: Added 'palettes' column.");
    } catch (e) {
    }

    // Columns that back sorting options; when any is newly added, existing
    // rows lack values, so reset last_scanned to force a full re-scan
    let needsRescan = false;
    for (const colDef of ["btime INTEGER", "star INTEGER", "duration REAL", "isDeleted INTEGER"]) {
        try {
            db.run(`ALTER TABLE items ADD COLUMN ${colDef}`);
            verboseLog(`Migration: Added '${colDef.split(' ')[0]}' column.`);
            needsRescan = true;
        } catch (e) {
        }
    }
    if (needsRescan) {
        db.run("UPDATE items SET last_scanned = 0");
        console.log("Schema updated with new sort columns; items will be refreshed on next scan.");
    }

    db.run(`CREATE INDEX IF NOT EXISTS idx_mod_time ON items(modificationTime)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_btime ON items(btime)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_name ON items(name)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_description ON items(description)`);
    verboseLog("Indices ensured.");
}

initDB();

export let folderCache: FolderCache = {
    folders: [],
    lockedFolderIds: new Set(),
    allTags: [],
    tagCounts: {},
    tagsGroups: [],
    lastUpdated: 0
};

function getLockedFolderIds(folders: Folder[]): Set<string> {
    const lockedIds = new Set<string>();
    function traverse(folderList: Folder[], isParentLocked = false) {
        for (const folder of folderList) {
            const isLocked = isParentLocked || (!!folder.password && folder.password.length > 0);
            if (isLocked) lockedIds.add(folder.id);
            if (folder.children) traverse(folder.children, isLocked);
        }
    }
    traverse(folders);
    return lockedIds;
}

export function updateTagCache() {
    try {
        const rows = db.query("SELECT tags, folders FROM items WHERE COALESCE(isDeleted, 0) = 0").all() as { tags: string; folders: string }[];
        const lockedIds = folderCache.lockedFolderIds;
        const counts: Record<string, number> = {};
        rows.forEach(row => {
            try {
                // Don't leak tags from items inside locked folders
                if (lockedIds.size) {
                    const folders = JSON.parse(row.folders || '[]');
                    if (Array.isArray(folders) && folders.some((f: string) => lockedIds.has(f))) return;
                }
                const tags = JSON.parse(row.tags);
                if (Array.isArray(tags)) tags.forEach((t: string) => { counts[t] = (counts[t] || 0) + 1; });
            } catch (e) { }
        });
        folderCache.allTags = Object.keys(counts).sort();
        folderCache.tagCounts = counts;
        verboseLog(`Tag cache updated. Found ${folderCache.allTags.length} unique tags.`);
    } catch (err) {
        console.error("Error updating tag cache:", err);
    }
}

let isScanning = false;
let scannedCount = 0;

export function getScanStatus() {
    return {
        isScanning,
        scannedCount
    };
}

interface Item {
    id: string;
    name: string;
    ext: string;
    size: number;
    modificationTime: number;
    btime?: number;
    width?: number;
    height?: number;
    tags?: string[];
    folders?: string[];
    annotation?: string;
    palettes?: any[];
    star?: number;
    duration?: number;
    isDeleted?: boolean;
    [key: string]: any;
}

const BATCH_SIZE = 1000;

export async function performLibraryScan() {
    if (isScanning || !libraryPath) {
        verboseLog("Skipping scan. isScanning:", isScanning, "libraryPath:", libraryPath);
        return;
    }
    isScanning = true;
    scannedCount = 0;
    console.log("Starting background library scan... (Bun Optimized)");
    verboseLog("Scan started with BATCH_SIZE:", BATCH_SIZE);

    try {
        const mainMetadataPath = path.join(libraryPath, "metadata.json");
        if (fs.existsSync(mainMetadataPath)) {
            const mainMetadataFile = await fs.promises.readFile(mainMetadataPath, "utf8");
            const mainMetadata = JSON.parse(mainMetadataFile);
            folderCache.folders = mainMetadata.folders;
            folderCache.tagsGroups = mainMetadata.tagsGroups || [];
            folderCache.lockedFolderIds = getLockedFolderIds(mainMetadata.folders);
            folderCache.lastUpdated = Date.now();
            verboseLog("Loaded global metadata.json. Folders count:", folderCache.folders.length, "Tag Groups:", folderCache.tagsGroups.length);
        }

        const imagesDir = path.join(libraryPath, "images");
        if (!fs.existsSync(imagesDir)) {
            console.error("Images directory not found:", imagesDir);
            return;
        }

        console.log("[SCAN] Fetching existing DB state...");
        const existingItemMap = new Map<string, number>();
        const rows = db.query("SELECT id, last_scanned FROM items").all() as any[];
        rows.forEach(r => existingItemMap.set(r.id, r.last_scanned));
        verboseLog(`Existing DB has ${rows.length} items.`);

        const allItemFolderNames = await fs.promises.readdir(imagesDir);
        const infoFolderNames = allItemFolderNames.filter((name) => name.endsWith(".info"));
        console.log(`[SCAN] Found ${infoFolderNames.length} item folders.`);

        const now = Date.now();

        const queryUpsert = db.prepare(`INSERT OR REPLACE INTO items (id, name, ext, size, modificationTime, btime, width, height, tags, folders, description, palettes, star, duration, isDeleted, last_scanned) VALUES ($id, $name, $ext, $size, $modificationTime, $btime, $width, $height, $tags, $folders, $description, $palettes, $star, $duration, $isDeleted, $last_scanned)`);
        const queryTouch = db.prepare(`UPDATE items SET last_scanned = $now WHERE id = $id`);

        let skippedCount = 0;
        let upsertCount = 0;

        for (let i = 0; i < infoFolderNames.length; i += BATCH_SIZE) {
            const batchFolders = infoFolderNames.slice(i, i + BATCH_SIZE);

            const results = await Promise.all(batchFolders.map(async (folderName) => {
                const id = folderName.slice(0, -5);
                const metaPath = path.join(imagesDir, folderName, "metadata.json");

                try {
                    const stats = await fs.promises.stat(metaPath);
                    const fileMtime = stats.mtime.getTime();
                    const lastScanned = existingItemMap.get(id);

                    if (lastScanned && fileMtime < lastScanned) {
                        return { type: 'skipped', id };
                    }

                    const jsonString = await fs.promises.readFile(metaPath, "utf8");
                    const item = JSON.parse(jsonString) as Item;
                    item.id = id;
                    return { type: 'upsert', item };

                } catch (e) {
                    verboseLog("Failed to read/stat metadata for", id, e);
                    return null;
                }
            }));

            const upserts: Item[] = [];
            const touches: string[] = [];

            results.forEach(r => {
                if (!r) return;
                if (r.type === 'upsert') upserts.push((r as any).item);
                else if (r.type === 'skipped') touches.push((r as any).id);
            });

            db.transaction(() => {
                for (const item of upserts) {
                    deleteItemCache(item.id);
                    queryUpsert.run({
                        $id: item.id,
                        $name: item.name,
                        $ext: item.ext,
                        $size: item.size,
                        $modificationTime: item.modificationTime,
                        $btime: item.btime || item.modificationTime || 0,
                        $width: item.width || 0,
                        $height: item.height || 0,
                        $tags: JSON.stringify(item.tags || []),
                        $folders: JSON.stringify(item.folders || []),
                        $description: item.annotation || "",
                        $palettes: JSON.stringify(item.palettes || []),
                        $star: item.star || 0,
                        $duration: item.duration || 0,
                        $isDeleted: item.isDeleted ? 1 : 0,
                        $last_scanned: now
                    });
                }
                for (const id of touches) {
                    queryTouch.run({ $now: now, $id: id });
                }
            })();

            upsertCount += upserts.length;
            skippedCount += touches.length;
            scannedCount += (upserts.length + touches.length);

            if (i % (BATCH_SIZE * 5) === 0 || (i + BATCH_SIZE >= infoFolderNames.length)) {
                console.log(`[SCAN] Processed ${scannedCount}/${infoFolderNames.length} (Upsert: ${upsertCount}, Skipped: ${skippedCount})`);
            }
            scanEmitter.emit('progress', {
                scannedCount,
                total: infoFolderNames.length,
                isScanning: true
            });
        }

        console.log(`[SCAN] Batch processing complete. Cleaning up old items...`);
        const cleanupStart = Date.now();
        const orphans = db.query(`SELECT id FROM items WHERE last_scanned < ?`).all(now) as { id: string }[];
        orphans.forEach(orphan => deleteItemCache(orphan.id));

        db.run(`DELETE FROM items WHERE last_scanned < ?`, [now]);
        const cleanupCount = db.query(`SELECT changes() as count`).get() as { count: number };
        verboseLog(`[SCAN] Deleted ${cleanupCount?.count || 0} orphaned items.`);

        console.log(`[SCAN] Cleanup complete in ${Date.now() - cleanupStart}ms`);

        console.log(`[SCAN] Updating tag cache...`);
        updateTagCache();
        console.log(`[SCAN] Tag cache update done. Scan logic complete in ${Date.now() - now}ms.`);
        console.log(`[SCAN] Complete. Total: ${scannedCount}, Upserts: ${upsertCount}, Skipped: ${skippedCount}, Removed: ${existingItemMap.size - scannedCount < 0 ? 0 : existingItemMap.size - scannedCount}`);

        scanEmitter.emit('complete', {
            scannedCount,
            total: infoFolderNames.length,
            isScanning: false
        });

    } catch (error) {
        console.error("Scan error:", error);
    } finally {
        isScanning = false;
        console.log("[SCAN] isScanning reset to false.");
    }
}

export function findFolderById(folders: Folder[], id: string): Folder | null {
    for (const folder of folders) {
        if (folder.id === id) return folder;
        if (folder.children) {
            const found = findFolderById(folder.children, id);
            if (found) return found;
        }
    }
    return null;
}

export function getAllSubFolderIds(folder: Folder): Set<string> {
    const ids = new Set([folder.id]);
    if (folder.children) {
        folder.children.forEach((child) => {
            const subIds = getAllSubFolderIds(child);
            subIds.forEach((id) => ids.add(id));
        });
    }
    return ids;
}

let watcher: FSWatcher | undefined;

declare global {
    var libraryWatcher: FSWatcher | undefined;
}

export function initWatcher() {
    if (watcher || !libraryPath) {
        verboseLog("Skipping watcher init. watcher exists:", !!watcher, "libraryPath:", libraryPath);
        return;
    }

    const imagesDir = path.join(libraryPath, "images");
    if (!fs.existsSync(imagesDir)) return;

    console.log("Initializing Real-time Watcher on:", imagesDir);
    verboseLog("Watcher options: persistent=true, interval=2000");

    watcher = chokidar.watch(imagesDir, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: true,
        usePolling: true,
        interval: 2000,
        binaryInterval: 2000
    });

    watcher
        .on('add', handleFileChange)
        .on('change', handleFileChange)
        .on('unlinkDir', handleDirUnlink)
        .on('error', (error: any) => console.error(`[WATCHER ERROR] ${error}`));
}

async function handleFileChange(filePath: string) {
    if (path.basename(filePath) !== 'metadata.json') return;

    const dirs = filePath.split(path.sep);
    const parentDir = dirs[dirs.length - 2];

    if (!parentDir.endsWith('.info')) return;

    try {
        const jsonString = await fs.promises.readFile(filePath, "utf8");
        const item = JSON.parse(jsonString) as Item;

        const stmt = db.prepare(`INSERT OR REPLACE INTO items (id, name, ext, size, modificationTime, btime, width, height, tags, folders, description, palettes, star, duration, isDeleted, last_scanned) VALUES ($id, $name, $ext, $size, $modificationTime, $btime, $width, $height, $tags, $folders, $description, $palettes, $star, $duration, $isDeleted, $last_scanned)`);

        deleteItemCache(item.id);
        stmt.run({
            $id: item.id,
            $name: item.name,
            $ext: item.ext,
            $size: item.size,
            $modificationTime: item.modificationTime,
            $btime: item.btime || item.modificationTime || 0,
            $width: item.width || 0,
            $height: item.height || 0,
            $tags: JSON.stringify(item.tags || []),
            $folders: JSON.stringify(item.folders || []),
            $description: item.annotation || "",
            $palettes: JSON.stringify(item.palettes || []),
            $star: item.star || 0,
            $duration: item.duration || 0,
            $isDeleted: item.isDeleted ? 1 : 0,
            $last_scanned: Date.now()
        });

        console.log(`[WATCHER] Updated item: ${item.id} (${item.name})`);
        verboseLog(`[WATCHER] DB upsert complete for ${item.id}`);
        updateTagCache();

    } catch (e) {
        console.error(`[WATCHER ERROR] Failed to process ${filePath}`, e);
    }
}

function handleDirUnlink(dirPath: string) {
    const dirName = path.basename(dirPath);
    if (!dirName.endsWith('.info')) return;

    const id = dirName.replace('.info', '');

    try {
        deleteItemCache(id);
        db.run("DELETE FROM items WHERE id = ?", [id]);
        console.log(`[WATCHER] Removed item: ${id}`);
        verboseLog(`[WATCHER] DB delete complete for ${id}`);
    } catch (e) {
        console.error(`[WATCHER ERROR] Failed to remove item ${id}`, e);
    }
}

if (!global.libraryWatcher) {
    initWatcher();
    global.libraryWatcher = watcher;
}
