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
    "Stop the Library Web Viewer server (and any other process using db/library.db) before rebuilding, then retry.";

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
