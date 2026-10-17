/// <reference types="bun" />
import { Database } from "bun:sqlite";
import fs from 'fs';
import path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { deleteItemCache, shutdownExiftool } from './thumbnailUtils';
import { ensureSchema } from './schema';
import { publishLockSnapshot } from './lockSnapshot';
import { LibraryIndexer, type Logger } from './scan';
import { createWatcherRouter } from './watcherEvents';
import { createScanService, runCleanupSteps, safeEmit } from './scanLifecycle';
import { resolveSseListenerLimit, resolveWatchPollInterval } from './sseStream';

export const scanEmitter = new EventEmitter();
// One 'progress' + one 'complete' listener per open SSE stream; bounded headroom, not unlimited (see sseStream.ts).
scanEmitter.setMaxListeners(resolveSseListenerLimit(process.env.SSE_MAX_LISTENERS));

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
// Reporting is best-effort: a failing console (closed pipe, broken reporter) must never change behavior.
function verboseLog(...args: any[]) {
    if (isVerbose) {
        try { console.log('[VERBOSE]', ...args); } catch { }
    }
}

function reportError(...args: any[]) {
    try { console.error(...args); } catch { }
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
    ensureSchema(db, verboseLog);
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
        reportError("Error updating tag cache:", err);
    }
}

const indexerLogger: Logger = {
    info: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
    verbose: verboseLog
};

// Production wiring of the injectable indexer (scan + watcher mutations are
// serialized inside it).
const indexer = new LibraryIndexer({
    db,
    libraryPath,
    invalidateCache: deleteItemCache,
    logger: indexerLogger,
    onProgress: ({ scannedCount, total }) => {
        safeEmit(scanEmitter, 'progress', { scannedCount, total, isScanning: true, status: 'scanning' }, indexerLogger);
    },
    onLibraryMetadata: (mainMetadata) => {
        // Validate, then publish atomically; invalid metadata keeps the previous
        // snapshot (or stays unready on first load) instead of unlocking everything.
        const result = publishLockSnapshot(folderCache, mainMetadata);
        if (!result.ok) {
            reportError(`[SCAN] Library metadata.json folder structure is invalid (${result.reason}); keeping the previous lock state${folderCache.lastUpdated > 0 ? '' : ' (library stays not ready)'}.`);
            return false;
        }
        verboseLog("Loaded global metadata.json. Folders count:", folderCache.folders.length, "Tag Groups:", folderCache.tagsGroups.length);
        return true;
    },
    onIndexChanged: updateTagCache
});

const scanService = createScanService({
    indexer,
    getLibraryPath: () => libraryPath,
    emitter: scanEmitter,
    logger: indexerLogger
});

/** Existing keys `isScanning`/`scannedCount` are unchanged; status/outcome/error/failedItems/finishedAt are additive. */
export const getScanStatus = scanService.getScanStatus;
/** Starts a scan if none is running; see StartScanResult (used by POST /api/scan). */
export const startLibraryScan = scanService.startLibraryScan;
/** Runs a scan to a definite LibraryScanResult (success | partial | busy | failure); never throws. */
export const performLibraryScan = scanService.performLibraryScan;

let closed = false;

/**
 * Releases everything a CLI process holds so it can exit: watcher, prepared
 * statements, database handle and the ExifTool child. Idempotent; each step is
 * attempted even if an earlier one fails. Do not call it inside the server.
 */
export async function closeResources(): Promise<void> {
    if (closed) return;
    closed = true;
    await runCleanupSteps([
        ["watcher", async () => {
            watcherRouter.dispose();
            const w = watcher;
            watcher = undefined;
            global.libraryWatcher = undefined;
            await w?.close();
        }],
        ["indexer", () => indexer.dispose()],
        ["database", () => db.close()],
        ["exiftool", () => shutdownExiftool()]
    ], indexerLogger);
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
    const pollInterval = resolveWatchPollInterval(process.env.WATCH_POLL_INTERVAL_MS);
    verboseLog(`Watcher options: persistent=true, usePolling=true, interval=${pollInterval}`);

    // Root metadata.json carries folder passwords/tag groups; images/ carries items and their originals
    watcher = chokidar.watch([imagesDir, path.join(libraryPath, "metadata.json")], {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: true,
        usePolling: true,
        interval: pollInterval,
        binaryInterval: pollInterval
    });

    watcher
        .on('add', (p) => watcherRouter.onFileEvent(p, 'add'))
        .on('change', (p) => watcherRouter.onFileEvent(p, 'change'))
        .on('unlink', (p) => watcherRouter.onFileEvent(p, 'unlink'))
        .on('unlinkDir', (p) => watcherRouter.onDirRemoved(p))
        .on('error', (error: any) => reportError(`[WATCHER ERROR] ${error}`));
}

// Debounces events, retries partially written metadata, reloads lock state on root metadata
// changes and invalidates generated media when originals change (see watcherEvents.ts).
const watcherRouter = createWatcherRouter({
    libraryPath,
    indexer,
    invalidateCache: deleteItemCache,
    logger: indexerLogger
});

if (!global.libraryWatcher) {
    initWatcher();
    global.libraryWatcher = watcher;
}
