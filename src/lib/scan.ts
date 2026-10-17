import type { Database, Statement } from "bun:sqlite";
import fs from 'fs';
import path from 'path';

/**
 * Library indexing logic, isolated from production wiring.
 *
 * This module must stay free of import-time side effects: it does not open a
 * database, read the environment, touch the cache directories or start a
 * watcher. Everything it needs is injected via IndexerDeps (see db.ts for the
 * production composition and tests/ for fixture-based usage).
 */

export interface Item {
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

/** Filesystem operations the indexer uses; override individual ones to inject failures. */
export interface ScanFs {
    readFile(filePath: string): Promise<string>;
    readdir(dirPath: string): Promise<string[]>;
    stat(filePath: string): Promise<{ mtimeMs: number }>;
    exists(filePath: string): boolean;
}

export interface Logger {
    info(...args: any[]): void;
    error(...args: any[]): void;
    verbose(...args: any[]): void;
}

export interface ScanProgress {
    scannedCount: number;
    total: number;
}

export interface IndexerDeps {
    db: Database;
    libraryPath: string;
    /** Drops generated thumbnails/previews for an item. */
    invalidateCache: (id: string) => void;
    onProgress?: (progress: ScanProgress) => void;
    /** Receives the parsed library-level metadata.json (folders, tag groups). */
    onLibraryMetadata?: (metadata: any) => void;
    /** Called after the index changed (end of a scan, after a watcher mutation). */
    onIndexChanged?: () => void;
    fs?: Partial<ScanFs>;
    logger?: Logger;
    now?: () => number;
    batchSize?: number;
}

export type ScanStatus = 'complete' | 'partial' | 'failed' | 'busy';

/** Machine-readable failure category; `error` keeps the raw (server-side only) detail. */
export type ScanErrorCode = 'images_unavailable' | 'library_metadata_invalid' | 'internal';

export interface ScanResult {
    status: ScanStatus;
    /** Total top-level `.info` directories found (0 when the inventory failed). */
    total: number;
    /** Items re-read and upserted plus unchanged items confirmed. */
    scanned: number;
    upserts: number;
    skipped: number;
    /** Present `.info` directories whose metadata could not be read/parsed. Their rows are preserved. */
    failures: { id: string; error: string }[];
    /** Rows actually deleted because their `.info` directory is gone. */
    removed: number;
    /** Raw failure detail; may contain filesystem paths, so it must not be sent to clients. */
    error?: string;
    errorCode?: ScanErrorCode;
}

const defaultFs: ScanFs = {
    readFile: (p) => fs.promises.readFile(p, "utf8"),
    readdir: (p) => fs.promises.readdir(p),
    stat: (p) => fs.promises.stat(p),
    exists: (p) => fs.existsSync(p),
};

const silentLogger: Logger = { info() { }, error() { }, verbose() { } };

/**
 * Reporting must never change control flow: a logger that throws would otherwise
 * escape from places such as the scan-release path and leave `scanning` stuck.
 * The indexer therefore only ever talks to a logger wrapped by this function.
 */
export function nonThrowingLogger<L extends Partial<Logger>>(logger: L): L {
    const guarded: Partial<Logger> = {};
    for (const level of ['info', 'error', 'verbose'] as const) {
        if (typeof logger[level] !== 'function') continue;
        guarded[level] = (...args: any[]) => {
            try {
                logger[level]!(...args);
            } catch {
                // swallow: logging is best-effort
            }
        };
    }
    return guarded as L;
}

const INFO_SUFFIX = ".info";

/** Removes the trailing `.info` only (never an earlier occurrence). Null if the name has no such suffix. */
export function itemIdFromDirName(dirName: string): string | null {
    return dirName.endsWith(INFO_SUFFIX) ? dirName.slice(0, -INFO_SUFFIX.length) : null;
}

const UPSERT_SQL = `INSERT INTO items (id, name, ext, size, modificationTime, btime, width, height, tags, folders, description, palettes, star, duration, isDeleted, last_scanned)
VALUES ($id, $name, $ext, $size, $modificationTime, $btime, $width, $height, $tags, $folders, $description, $palettes, $star, $duration, $isDeleted, $last_scanned)
ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    ext = excluded.ext,
    size = excluded.size,
    modificationTime = excluded.modificationTime,
    btime = excluded.btime,
    width = excluded.width,
    height = excluded.height,
    tags = excluded.tags,
    folders = excluded.folders,
    description = excluded.description,
    palettes = excluded.palettes,
    star = excluded.star,
    duration = excluded.duration,
    isDeleted = excluded.isDeleted,
    last_scanned = excluded.last_scanned`;

type PendingMutation = 'upsert' | 'remove';

export class LibraryIndexer {
    private readonly fsOps: ScanFs;
    private readonly log: Logger;
    private readonly now: () => number;
    private readonly batchSize: number;
    private scanning = false;
    private scanned = 0;
    /** Watcher events that arrived during a scan, replayed (last event per id wins) once it finishes. */
    private pending = new Map<string, PendingMutation>();
    /** Serializes watcher-originated mutations so they never overlap each other or a scan. */
    private chain: Promise<void> = Promise.resolve();

    constructor(private readonly deps: IndexerDeps) {
        this.fsOps = { ...defaultFs, ...deps.fs };
        this.log = nonThrowingLogger(deps.logger ?? silentLogger);
        this.now = deps.now ?? Date.now;
        this.batchSize = deps.batchSize ?? 1000;
    }

    get isScanning() {
        return this.scanning;
    }

    get scannedCount() {
        return this.scanned;
    }

    private get imagesDir() {
        return path.join(this.deps.libraryPath, "images");
    }

    private metadataPathFor(id: string) {
        return path.join(this.imagesDir, id + INFO_SUFFIX, "metadata.json");
    }

    private statements = new Map<string, Statement>();

    private stmt(sql: string): Statement {
        let s = this.statements.get(sql);
        if (!s) {
            s = this.deps.db.prepare(sql);
            this.statements.set(sql, s);
        }
        return s;
    }

    /** Finalizes cached prepared statements so the database file can be closed/removed (tests, shutdown). */
    dispose() {
        for (const s of this.statements.values()) s.finalize();
        this.statements.clear();
    }

    /** Explicit BEGIN/COMMIT (bun's db.transaction keeps the database file locked on Windows after close). */
    private inTransaction(fn: () => void) {
        const { db } = this.deps;
        db.run("BEGIN");
        try {
            fn();
            db.run("COMMIT");
        } catch (error) {
            try {
                db.run("ROLLBACK");
            } catch (rollbackError) {
                // Keep both diagnostics; the original failure stays the primary message
                const original = error instanceof Error ? error.message : String(error);
                const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                throw new Error(`${original} (rollback also failed: ${rollback})`, { cause: error });
            }
            throw error;
        }
    }

    private upsertItem(item: Item, lastScanned: number) {
        this.stmt(UPSERT_SQL).run({
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
            $last_scanned: lastScanned
        });
    }

    /** Forces the next scan to re-read `id` regardless of the file's mtime, without touching content. */
    private markForRetry(id: string) {
        this.stmt("UPDATE items SET last_scanned = 0 WHERE id = ?").run(id);
    }

    /**
     * Cache invalidation deliberately runs inside the surrounding transaction,
     * before the row changes. It cannot be rolled back, so a failed batch may
     * leave rows untouched but derived caches dropped; that is the safe direction
     * (caches are regenerated on demand, whereas invalidating after commit could
     * leave stale caches if the process dies between commit and invalidation).
     */
    private deleteItem(id: string): number {
        this.deps.invalidateCache(id);
        return this.stmt("DELETE FROM items WHERE id = ?").run(id).changes;
    }

    async scan(): Promise<ScanResult> {
        const result: ScanResult = {
            status: 'failed', total: 0, scanned: 0, upserts: 0, skipped: 0, failures: [], removed: 0
        };

        if (this.scanning) {
            this.log.verbose("Skipping scan; one is already running.");
            return { ...result, status: 'busy' };
        }
        this.scanning = true;
        this.scanned = 0;

        try {
            // Let in-flight watcher mutations land before we snapshot anything
            await this.chain;

            await this.runScan(result);
        } catch (error) {
            this.log.error("Scan error:", error);
            result.status = 'failed';
            result.error = error instanceof Error ? error.message : String(error);
            result.errorCode ??= 'internal';
        } finally {
            // Events that arrived while scanning are applied now, against fresh file
            // contents; scan ownership is released inside the same routine.
            await this.drainAndRelease();
        }

        try {
            this.deps.onIndexChanged?.();
        } catch (error) {
            this.log.error("Index change hook failed:", error);
        }
        return result;
    }

    private async runScan(result: ScanResult) {
        const { libraryPath } = this.deps;
        this.log.info("Starting background library scan... (Bun Optimized)");

        const mainMetadataPath = path.join(libraryPath, "metadata.json");
        if (this.fsOps.exists(mainMetadataPath)) {
            let mainMetadata: any;
            try {
                mainMetadata = JSON.parse(await this.fsOps.readFile(mainMetadataPath));
                if (mainMetadata === null || typeof mainMetadata !== "object" || Array.isArray(mainMetadata)) {
                    throw new Error("Library metadata.json is not a JSON object");
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.log.error(`[SCAN] Library metadata.json is unreadable or malformed; leaving the index untouched. ${message}`);
                result.status = 'failed';
                result.error = message;
                result.errorCode = 'library_metadata_invalid';
                return;
            }
            this.deps.onLibraryMetadata?.(mainMetadata);
        }

        // 1. Inventory. Everything destructive depends on this succeeding.
        let infoFolderNames: string[];
        try {
            if (!this.fsOps.exists(this.imagesDir)) {
                throw new Error(`Images directory not found: ${this.imagesDir}`);
            }
            const allNames = await this.fsOps.readdir(this.imagesDir);
            infoFolderNames = allNames.filter((name) => name.endsWith(INFO_SUFFIX));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log.error(`[SCAN] Could not enumerate ${this.imagesDir}; leaving the index untouched (no cleanup). ${message}`);
            result.status = 'failed';
            result.error = message;
            result.errorCode = 'images_unavailable';
            return;
        }

        // Presence is established here, independent of whether metadata parses later
        const presentIds = new Set<string>();
        for (const name of infoFolderNames) presentIds.add(itemIdFromDirName(name)!);
        result.total = infoFolderNames.length;
        this.log.info(`[SCAN] Found ${infoFolderNames.length} item folders.`);

        const existingItemMap = new Map<string, number>();
        const rows = this.stmt("SELECT id, last_scanned FROM items").all() as { id: string; last_scanned: number }[];
        rows.forEach(r => existingItemMap.set(r.id, r.last_scanned));

        const now = this.now();
        const queryTouch = this.stmt(`UPDATE items SET last_scanned = $now WHERE id = $id`);

        for (let i = 0; i < infoFolderNames.length; i += this.batchSize) {
            const batchFolders = infoFolderNames.slice(i, i + this.batchSize);

            const results = await Promise.all(batchFolders.map(async (folderName) => {
                const id = itemIdFromDirName(folderName)!;
                const metaPath = path.join(this.imagesDir, folderName, "metadata.json");

                try {
                    const stats = await this.fsOps.stat(metaPath);
                    const lastScanned = existingItemMap.get(id);

                    if (lastScanned && stats.mtimeMs < lastScanned) {
                        return { type: 'skipped' as const, id };
                    }

                    const item = JSON.parse(await this.fsOps.readFile(metaPath)) as Item;
                    item.id = id;
                    return { type: 'upsert' as const, id, item };
                } catch (e) {
                    this.log.verbose("Failed to read/stat metadata for", id, e);
                    return { type: 'failed' as const, id, error: e instanceof Error ? e.message : String(e) };
                }
            }));

            const upserts: Item[] = [];
            const touches: string[] = [];
            for (const r of results) {
                if (r.type === 'upsert') upserts.push(r.item);
                else if (r.type === 'skipped') touches.push(r.id);
                else result.failures.push({ id: r.id, error: r.error });
            }

            // Failed ids keep their indexed content but get last_scanned = 0, so the
            // next scan re-reads them even if the file's mtime is older than the old marker.
            const failedIds = results.flatMap(r => r.type === 'failed' ? [r.id] : []);
            this.inTransaction(() => {
                for (const item of upserts) {
                    this.deps.invalidateCache(item.id);
                    this.upsertItem(item, now);
                }
                for (const id of touches) {
                    queryTouch.run({ $now: now, $id: id });
                }
                for (const id of failedIds) this.markForRetry(id);
            });

            result.upserts += upserts.length;
            result.skipped += touches.length;
            this.scanned += upserts.length + touches.length;
            result.scanned = this.scanned;

            if (i % (this.batchSize * 5) === 0 || (i + this.batchSize >= infoFolderNames.length)) {
                this.log.info(`[SCAN] Processed ${this.scanned}/${infoFolderNames.length} (Upsert: ${result.upserts}, Skipped: ${result.skipped}, Failed: ${result.failures.length})`);
            }
            this.deps.onProgress?.({ scannedCount: this.scanned, total: infoFolderNames.length });
        }

        // 2. Cleanup: only rows whose .info directory is absent from the inventory
        this.log.info(`[SCAN] Batch processing complete. Cleaning up removed items...`);
        const cleanupStart = Date.now();
        const currentIds = (this.stmt("SELECT id FROM items").all() as { id: string }[]).map(r => r.id);
        const absentIds = currentIds.filter(id => !presentIds.has(id));
        let removed = 0;
        this.inTransaction(() => {
            for (const id of absentIds) removed += this.deleteItem(id);
        });
        result.removed = removed; // published only once the cleanup committed
        this.log.info(`[SCAN] Cleanup complete in ${Date.now() - cleanupStart}ms (deleted ${result.removed} rows)`);

        if (result.failures.length) {
            const sample = result.failures.slice(0, 5).map(f => f.id).join(", ");
            this.log.error(`[SCAN] ${result.failures.length} item(s) had unreadable metadata and were left unchanged (will retry next scan): ${sample}${result.failures.length > 5 ? ", ..." : ""}`);
        }
        this.log.info(`[SCAN] ${result.failures.length ? 'Completed with failures' : 'Complete'}. Total: ${this.scanned}, Upserts: ${result.upserts}, Skipped: ${result.skipped}, Failed: ${result.failures.length}, Removed: ${result.removed}`);

        result.status = result.failures.length ? 'partial' : 'complete';
    }

    /** Watcher entry point: a metadata.json for `id` was added/changed. */
    itemChanged(id: string): Promise<void> {
        return this.submit(id, 'upsert');
    }

    /** Watcher entry point: the `.info` directory for `id` was removed. */
    itemRemoved(id: string): Promise<void> {
        return this.submit(id, 'remove');
    }

    private submit(id: string, kind: PendingMutation): Promise<void> {
        if (this.scanning) {
            this.pending.set(id, kind);
            return Promise.resolve();
        }
        const run = this.chain.then(() => this.applyMutation(id, kind));
        this.chain = run.catch(() => { });
        return run;
    }

    /**
     * Applies queued watcher events, then releases scan ownership. The "queue is
     * empty" check and `scanning = false` share one synchronous segment (no await
     * in between), so an event can never be queued after the final check and
     * stranded: it either lands in `pending` before the check and is drained, or
     * arrives after the release and takes the normal serial path in submit().
     */
    private async drainAndRelease() {
        for (; ;) {
            if (!this.pending.size) {
                this.scanning = false;
                return;
            }
            const batch = [...this.pending];
            this.pending.clear();
            for (const [id, kind] of batch) {
                try {
                    await this.applyMutation(id, kind);
                } catch (error) {
                    this.log.error("Failed replaying queued watcher event:", id, error);
                }
            }
        }
    }

    private async applyMutation(id: string, kind: PendingMutation) {
        try {
            if (kind === 'remove') {
                this.deleteItem(id);
                this.log.info(`[WATCHER] Removed item: ${id}`);
            } else {
                let item: Item;
                try {
                    item = JSON.parse(await this.fsOps.readFile(this.metadataPathFor(id))) as Item;
                } catch (e) {
                    // Unreadable now: keep whatever is indexed and force the next scan to retry
                    this.log.error(`[WATCHER ERROR] Failed to read metadata for ${id}; existing row left unchanged`, e);
                    this.markForRetry(id);
                    return;
                }
                item.id = id;
                this.deps.invalidateCache(id);
                this.upsertItem(item, this.now());
                this.log.info(`[WATCHER] Updated item: ${id} (${item.name})`);
            }
            // During a scan the end-of-scan hook covers this
            if (!this.scanning) this.deps.onIndexChanged?.();
        } catch (e) {
            this.log.error(`[WATCHER ERROR] Failed to apply ${kind} for item ${id}`, e);
        }
    }
}
