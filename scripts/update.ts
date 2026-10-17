
import { initDB, performLibraryScan, scanEmitter, closeResources } from '../src/lib/db';
import { EXIT_CODES, finishCli, runScanCommand } from '../src/lib/scanLifecycle';

// Exit codes: 0 success, 1 failure, 2 partial (some items unreadable).
async function runUpdate() {
    console.log("==========================================");
    console.log("      Eagle Web Viewer - Update Lib       ");
    console.log("==========================================");

    console.log("\n[UPDATE] Scanning for changes...");
    return runScanCommand({
        label: "UPDATE",
        scan: performLibraryScan,
        emitter: scanEmitter,
        prepare: initDB,
        cleanup: closeResources
    });
}

runUpdate().then(finishCli, (error) => {
    console.error("[UPDATE] FAILED unexpectedly:", error);
    finishCli(EXIT_CODES.FAILURE);
});
