/**
 * Subprocess scenario for tests/regeneration.integration.test.ts. It runs the
 * PRODUCTION thumbnail/preview route handlers and cache wiring (db.ts,
 * thumbnailUtils.ts) against a disposable library, in an isolated process because
 * db.ts opens `<cwd>/db` and reads LIBRARY_PATH at import time.
 *
 * Invoked with cwd = a temp dir and LIBRARY_PATH = a temp library; it never touches
 * the workspace db/ or the real library. Prints one `RESULT:<json>` line.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const libraryPath = process.env.LIBRARY_PATH!;
const itemDir = path.join(libraryPath, 'images', 'ITEM1.info');
const sourceFile = path.join(itemDir, 'pic.png');
const metaFile = path.join(itemDir, 'metadata.json');

const solid = (r: number, g: number, b: number) =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).png().toBuffer();

fs.mkdirSync(itemDir, { recursive: true });
fs.writeFileSync(path.join(libraryPath, 'metadata.json'), JSON.stringify({ folders: [], tagsGroups: [] }));
fs.writeFileSync(metaFile, JSON.stringify({
    id: 'ITEM1', name: 'pic', ext: 'png', size: 1, modificationTime: 1_700_000_000_000, btime: 1_700_000_000_000,
    width: 64, height: 64, tags: [], folders: [], annotation: '', palettes: [], star: 0, duration: 0, isDeleted: false
}));
fs.writeFileSync(sourceFile, await solid(255, 0, 0));

const hashFile = (p: string) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
const libraryHashes = () => Object.fromEntries(
    [path.join(libraryPath, 'metadata.json'), metaFile, sourceFile].map(p => [path.relative(libraryPath, p), hashFile(p)]));

const { closeResources, performLibraryScan } = await import('../../src/lib/db');
const { deleteItemCache, CACHE_DIR, PREVIEW_CACHE_DIR } = await import('../../src/lib/thumbnailUtils');
const { createWatcherRouter } = await import('../../src/lib/watcherEvents');
const thumbnailRoute = (await import('../../src/pages/api/thumbnail/[id]')).GET as any;
const previewRoute = (await import('../../src/pages/api/preview/[id]')).GET as any;

const scan = await performLibraryScan();

async function fetchMedia(route: any) {
    const res: Response = await route({ params: { id: 'ITEM1' }, request: new Request('http://localhost/x') });
    const body = Buffer.from(await res.arrayBuffer());
    const { data } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
    return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        etag: res.headers.get('etag'),
        red: data[0], blue: data[2],
        sha: crypto.createHash('sha1').update(body).digest('hex')
    };
}

const cacheFiles = () => ({
    thumbnail: hashFile(path.join(CACHE_DIR, 'ITEM1.webp')),
    preview: hashFile(path.join(PREVIEW_CACHE_DIR, 'ITEM1.webp'))
});

const before = { thumbnail: await fetchMedia(thumbnailRoute), preview: await fetchMedia(previewRoute) };
const cachedBefore = cacheFiles();
const sourcesBefore = libraryHashes();

// Source edited, no event yet: the cache is (intentionally) still served
fs.writeFileSync(sourceFile, await solid(0, 0, 255));
const sourcesEdited = libraryHashes();
const stale = { thumbnail: await fetchMedia(thumbnailRoute), preview: await fetchMedia(previewRoute) };

// Watcher event for the edited original -> production invalidation (deleteItemCache)
const router = createWatcherRouter({
    libraryPath,
    indexer: {
        itemChanged: async () => 'applied',
        itemRemoved: async () => 'applied',
        refreshLibraryMetadata: async () => 'applied'
    },
    invalidateCache: deleteItemCache,
    debounceMs: 10
});
router.onFileEvent(sourceFile, 'change');
await new Promise(r => setTimeout(r, 200));
router.dispose();

const cacheGone = !fs.existsSync(path.join(CACHE_DIR, 'ITEM1.webp')) && !fs.existsSync(path.join(PREVIEW_CACHE_DIR, 'ITEM1.webp'));
const after = { thumbnail: await fetchMedia(thumbnailRoute), preview: await fetchMedia(previewRoute) };
const cachedAfter = cacheFiles();
const sourcesAfter = libraryHashes();

console.log('RESULT:' + JSON.stringify({
    scanOutcome: scan.outcome, before, stale, after, cachedBefore, cachedAfter, cacheGone,
    sourcesBefore, sourcesEdited, sourcesAfter
}));

await closeResources();
process.exit(0);
