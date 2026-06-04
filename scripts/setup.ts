
import { initDB, performLibraryScan, scanEmitter } from '../src/lib/db';

async function runSetup() {
    console.log("==========================================");
    console.log("   Eagle Web Viewer - First Time Setup    ");
    console.log("==========================================");

    console.log("\n[SETUP] ensuring database is ready...");
    initDB();

    console.log("\n[SETUP] Starting initial library scan...");

    scanEmitter.on('progress', (data) => {
        process.stdout.write(`\r[SETUP] Scanning: ${data.scannedCount}/${data.total}`);
    });

    scanEmitter.on('complete', (data) => {
        console.log(`\n[SETUP] Scan complete! Total items: ${data.scannedCount}`);
        console.log("\n[SETUP] Setup finished successfully.");
        process.exit(0);
    });

    await performLibraryScan();
}

runSetup();
