
import { EXIT_CODES, finishCli, runThumbnailCommand } from '../src/lib/scanLifecycle';

// Exit codes: 0 success (including an empty library; unsupported items are skipped, not errors),
// 1 failure (not configured, items could not be enumerated, unexpected error), 2 partial (some items errored).
async function run(): Promise<number> {
    // Imported lazily so a database that cannot be opened is reported as a failure, not a module-load crash
    const { db, libraryPath, closeResources } = await import('../src/lib/db');
    const { generateThumbnail } = await import('../src/lib/thumbnailUtils');

    return runThumbnailCommand({
        libraryPath,
        listItems: () => db.query("SELECT id, name FROM items").all() as { id: string }[],
        generate: generateThumbnail,
        // Closes the watcher, DB and the ExifTool child so the process can end on its own
        cleanup: closeResources
    });
}

run().then(finishCli, (error) => {
    console.error("Fatal error:", error);
    finishCli(EXIT_CODES.FAILURE);
});
