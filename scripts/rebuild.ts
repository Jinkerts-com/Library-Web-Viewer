import path from 'path';
import { removeDatabaseFiles, SERVER_MUST_BE_STOPPED } from '../src/lib/rebuildGuard';
import { EXIT_CODES, finishCli, runScanCommand } from '../src/lib/scanLifecycle';

// Exit codes: 0 success, 1 failure (including failure to remove the old database), 2 partial (some items unreadable).
async function rebuild() {
    console.log("==========================================");
    console.log("   Eagle Web Viewer - Rebuild Database    ");
    console.log("==========================================");
    console.log("[REBUILD] NOTE: the server must be stopped before a rebuild.");

    const dbDir = path.join(process.cwd(), "db");

    const { removed, failed } = removeDatabaseFiles(dbDir);
    for (const file of removed) console.log(`[REBUILD] Deleted ${file}`);
    if (failed) {
        console.error(`\n[REBUILD] FAILED: could not delete ${failed.file}: ${failed.message}`);
        console.error(`[REBUILD] ${SERVER_MUST_BE_STOPPED}`);
        console.error("[REBUILD] The scan was not started; the database was not rebuilt.");
        return EXIT_CODES.FAILURE;
    }

    console.log(removed.length
        ? "\n[REBUILD] Existing database wiped. Starting fresh setup..."
        : "\n[REBUILD] No existing database found. Starting fresh setup...");

    // Import after deleting DB files so SQLite does not hold an open file handle.
    const { initDB, performLibraryScan, scanEmitter, closeResources } = await import('../src/lib/db');

    console.log("\n[REBUILD] Starting library scan...");
    return runScanCommand({
        label: "REBUILD",
        scan: performLibraryScan,
        emitter: scanEmitter,
        prepare: initDB,
        cleanup: closeResources
    });
}

rebuild().then(finishCli, (error) => {
    console.error("[REBUILD] FAILED unexpectedly:", error);
    finishCli(EXIT_CODES.FAILURE);
});
