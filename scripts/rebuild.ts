import fs from 'fs';
import path from 'path';

async function rebuild() {
    console.log("==========================================");
    console.log("   Eagle Web Viewer - Rebuild Database    ");
    console.log("==========================================");

    const rootDir = process.cwd();
    const dbDir = path.join(rootDir, "db");

    const dbFiles = ["library.db", "library.db-wal", "library.db-shm"];

    let deleted = false;
    for (const file of dbFiles) {
        const filePath = path.join(dbDir, file);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                console.log(`[REBUILD] Deleted ${file}`);
                deleted = true;
            } catch (err) {
                console.error(`[REBUILD] Failed to delete ${file}:`, err);
            }
        }
    }

    if (deleted) {
        console.log("\n[REBUILD] Existing database wiped. Starting fresh setup...");
    } else {
        console.log("\n[REBUILD] No existing database found. Starting fresh setup...");
    }

    // Import after deleting DB files so SQLite does not hold an open file handle.
    const { initDB, performLibraryScan, scanEmitter } = await import('../src/lib/db');

    console.log("\n[REBUILD] Ensuring database is ready...");
    initDB();

    console.log("\n[REBUILD] Starting library scan...");

    scanEmitter.on('progress', (data: any) => {
        process.stdout.write(`\r[REBUILD] Scanning: ${data.scannedCount}/${data.total}`);
    });

    scanEmitter.on('complete', (data: any) => {
        console.log(`\n\n[REBUILD] Scan complete! Total items: ${data.scannedCount}`);
        console.log("\n[REBUILD] Rebuild finished successfully.");
        process.exit(0);
    });

    await performLibraryScan();
}

rebuild();
