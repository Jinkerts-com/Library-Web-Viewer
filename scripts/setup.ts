
import { initDB, performLibraryScan, scanEmitter, closeResources } from '../src/lib/db';
import { EXIT_CODES, finishCli, runScanCommand } from '../src/lib/scanLifecycle';

// Exit codes: 0 success, 1 failure, 2 partial (some items unreadable).
async function runSetup() {
    console.log("==========================================");
    console.log("   Eagle Web Viewer - First Time Setup    ");
    console.log("==========================================");

    console.log("\n[SETUP] ensuring database is ready and starting initial library scan...");
    return runScanCommand({
        label: "SETUP",
        scan: performLibraryScan,
        emitter: scanEmitter,
        prepare: initDB,
        cleanup: closeResources
    });
}

runSetup().then(finishCli, (error) => {
    console.error("[SETUP] FAILED unexpectedly:", error);
    finishCli(EXIT_CODES.FAILURE);
});
