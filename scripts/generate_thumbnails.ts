
import { db } from '../src/lib/db';
import { generateThumbnail } from '../src/lib/thumbnailUtils';

async function getAllItems() {
    try {
        return db.query("SELECT id, name FROM items").all() as any[];
    } catch (e) {
        console.error("Failed to fetch items", e);
        return [];
    }
}

async function run() {
    console.log("Starting bulk thumbnail generation...");

    // Give DB a moment to initialize if needed (though importing it usually runs initDB)
    await new Promise(r => setTimeout(r, 1000));

    try {
        const items: any[] = await getAllItems();
        console.log(`Found ${items.length} items.`);

        let processed = 0;
        let generated = 0;
        let skipped = 0;
        let errors = 0;

        const concurrency = 10;

        for (let i = 0; i < items.length; i += concurrency) {
            const batch = items.slice(i, i + concurrency);
            await Promise.all(batch.map(async (item) => {
                try {
                    const result = await generateThumbnail(item.id);
                    if (result) generated++;
                    else skipped++;
                } catch (e) {
                    console.error(`Failed ${item.id}:`, e);
                    errors++;
                }
            }));

            processed += batch.length;
            if (processed % 100 === 0) {
                process.stdout.write(`\rProgress: ${processed}/${items.length} ...`);
            }
        }

        console.log(`\nDone! Processed: ${processed}. Errors: ${errors}.`);
        process.exit(0);

    } catch (e) {
        console.error("Fatal error:", e);
        process.exit(1);
    }
}

run();
