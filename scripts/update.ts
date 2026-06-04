
import { initDB, performLibraryScan, scanEmitter } from '../src/lib/db';

async function runUpdate() {
    console.log("==========================================");
    console.log("      Eagle Web Viewer - Update Lib       ");
    console.log("==========================================");

    initDB();

    console.log("\n[UPDATE] Scanning for changes...");

    scanEmitter.on('progress', (data) => {
        process.stdout.write(`\r[UPDATE] Processed: ${data.scannedCount}/${data.total}`);
    });

    scanEmitter.on('complete', (data) => {
        console.log(`\n[UPDATE] Update complete! Total items: ${data.scannedCount}`);
        process.exit(0);
    });

    await performLibraryScan();
}

runUpdate();
