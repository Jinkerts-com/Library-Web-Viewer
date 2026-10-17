import fs from 'fs';
import path from 'path';

/** Main database first: if it cannot be removed nothing else is touched. */
export const DB_FILES = ["library.db", "library.db-wal", "library.db-shm"];

export interface RemoveOps {
    exists(p: string): boolean;
    unlink(p: string): void;
}

export interface RemoveResult {
    removed: string[];
    /** Set when a required removal failed; removal stops at the first failure. */
    failed?: { file: string; message: string };
}

export const SERVER_MUST_BE_STOPPED =
    "Stop the Library Web Viewer server (and any other process using db/library.db or db/cache) before rebuilding, then retry.";

/** The ONLY cache directories (under db/cache) a rebuild may empty: derived, regenerable media. */
export const DERIVED_CACHE_DIRS = ["thumbnails", "previews"];

/** What a path is, without following links. */
export type PathKind = 'absent' | 'directory' | 'link' | 'other';

export interface CacheClearOps {
    /** Classifies `p` WITHOUT following a link at `p`. Throws when it cannot be inspected (anything but "absent"). */
    inspect(p: string): PathKind;
    readdir(p: string): string[];
    /** Removes one entry (file, link, or a stray temp directory); never follows symlinks/junctions. */
    remove(p: string): void;
}

const defaultCacheOps: CacheClearOps = {
    inspect: (p) => {
        try {
            const stat = fs.lstatSync(p);
            if (stat.isSymbolicLink()) return 'link';
            return stat.isDirectory() ? 'directory' : 'other';
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
            throw error;
        }
    },
    readdir: (p) => fs.readdirSync(p),
    remove: (p) => fs.rmSync(p, { recursive: true, force: true })
};

export interface CacheClearResult {
    /** Number of cache entries removed. */
    removed: number;
    /** Cache paths (relative to dbDir) deliberately left alone because they are links or not directories. */
    skipped?: string[];
    failed?: { file: string; message: string };
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Empties the derived thumbnail/preview caches (`<dbDir>/cache/thumbnails|previews`).
 * The directories themselves are kept and nothing else under `db/` is touched.
 * Only valid while the server is stopped; stops at the first failure.
 *
 * Safety: every component of the hierarchy below `dbDir` (`cache`, then the
 * derived directory) is inspected with lstat BEFORE anything is read or deleted,
 * so a link/junction at `cache` or at a leaf is never traversed (that would delete
 * external content). A link or non-directory is skipped deliberately and reported
 * in `skipped`; an absent path is simply nothing to clear; an inspection error
 * (e.g. access denied) FAILS the clear because safe cleanup cannot be established.
 * Entries inside a derived directory are removed without following links, so a
 * link there loses only the link itself. `dbDir` itself is the operator's chosen
 * location and is not validated.
 */
export function clearDerivedCaches(dbDir: string, ops: CacheClearOps = defaultCacheOps): CacheClearResult {
    let removed = 0;
    const skipped: string[] = [];
    const done = (failed?: CacheClearResult['failed']): CacheClearResult => ({
        removed,
        ...(skipped.length ? { skipped } : {}),
        ...(failed ? { failed } : {})
    });

    const cacheRel = "cache";
    let cacheKind: PathKind;
    try {
        cacheKind = ops.inspect(path.join(dbDir, cacheRel));
    } catch (error) {
        return done({ file: cacheRel, message: `could not inspect: ${messageOf(error)}` });
    }
    if (cacheKind === 'absent') return done();
    if (cacheKind !== 'directory') { skipped.push(cacheRel); return done(); }

    for (const name of DERIVED_CACHE_DIRS) {
        const rel = path.join(cacheRel, name);
        const dir = path.join(dbDir, rel);
        let kind: PathKind;
        try {
            kind = ops.inspect(dir);
        } catch (error) {
            return done({ file: rel, message: `could not inspect: ${messageOf(error)}` });
        }
        if (kind === 'absent') continue;
        if (kind !== 'directory') { skipped.push(rel); continue; }
        try {
            for (const entry of ops.readdir(dir)) {
                try {
                    ops.remove(path.join(dir, entry));
                    removed++;
                } catch (error) {
                    return done({ file: path.join(rel, entry), message: messageOf(error) });
                }
            }
        } catch (error) {
            return done({ file: rel, message: messageOf(error) });
        }
    }
    return done();
}

/**
 * Removes the SQLite files for a rebuild. A failure is never ignored: the caller
 * must abort. Failing is also the only protection against a running server on
 * Windows (open files cannot be unlinked); on other platforms the operator must
 * stop the server first, hence the explicit message.
 */
export function removeDatabaseFiles(
    dbDir: string,
    ops: RemoveOps = { exists: fs.existsSync, unlink: fs.unlinkSync }
): RemoveResult {
    const removed: string[] = [];
    for (const file of DB_FILES) {
        const filePath = path.join(dbDir, file);
        if (!ops.exists(filePath)) continue;
        try {
            ops.unlink(filePath);
            removed.push(file);
        } catch (error) {
            return { removed, failed: { file, message: error instanceof Error ? error.message : String(error) } };
        }
    }
    return { removed };
}
