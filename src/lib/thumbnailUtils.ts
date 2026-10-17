
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { exiftool } from 'exiftool-vendored';
import { libraryPath } from './db';
import { isSafeItemId, resolveCacheFile, resolveItemDir, realFileInside, isAuxiliaryItemFile, isLibraryThumbnailFile } from './mediaPaths';
import { MediaGenerationCoordinator, resolveThumbnailSettings } from './mediaCache';

export const CACHE_DIR = path.join(process.cwd(), 'db', 'cache', 'thumbnails');
export const PREVIEW_CACHE_DIR = path.join(process.cwd(), 'db', 'cache', 'previews');

/** Coalesces misses per item, bounds aggregate thumbnail+preview generation, and fences stale writes (see mediaCache.ts). */
const coordinator = new MediaGenerationCoordinator(4);

/** Validated once at module load; sharp never sees NaN or an out-of-range value. */
export const thumbnailSettings = resolveThumbnailSettings(process.env, (message) => {
    try { console.warn(`[THUMBNAILS] ${message}`); } catch { }
});

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(PREVIEW_CACHE_DIR)) {
    fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });
}

// Reporting is best-effort: a throwing reporter must not change a skip/fallback into an escaped exception.
function reportError(...args: any[]) {
    try { console.error(...args); } catch { }
}

/** Ends the shared ExifTool child process (safe if it was never started); CLI scripts call this on shutdown. */
export async function shutdownExiftool(): Promise<void> {
    await exiftool.end();
}

/** Last-modified time (epoch ms) of an item's cached thumbnail/preview, or null when not cached. */
export function cachedMediaMtime(kind: 'thumbnail' | 'preview', itemId: string): number | null {
    const file = resolveCacheFile(kind === 'thumbnail' ? CACHE_DIR : PREVIEW_CACHE_DIR, itemId);
    if (!file) return null;
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return null;
    }
}

export function deleteItemCache(itemId: string) {
    // Fence first: any in-flight generation for this item must not publish its result
    coordinator.invalidate(itemId);
    // Validated here, independently of any caller: an unsafe id never reaches unlink
    const thumbPath = resolveCacheFile(CACHE_DIR, itemId);
    const previewPath = resolveCacheFile(PREVIEW_CACHE_DIR, itemId);
    if (!thumbPath || !previewPath) {
        reportError("Refusing to delete cache for an invalid item id");
        return;
    }
    try {
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
    } catch (e) {
        reportError(`Failed to delete cache for ${itemId}:`, e);
    }
}

/** Existing, contained (realpath), regular source file in the item dir, or null. */
function safeSourcePath(imagesRoot: string, itemFolder: string, fileName: string): string | null {
    const real = realFileInside(imagesRoot, path.join(itemFolder, fileName));
    if (!real) return null;
    try {
        return path.dirname(real) === fs.realpathSync(itemFolder) ? real : null;
    } catch {
        return null;
    }
}

export async function generateThumbnail(itemId: string): Promise<Buffer | null> {
    if (!libraryPath || !isSafeItemId(itemId)) return null;

    const cacheFilePath = resolveCacheFile(CACHE_DIR, itemId);
    if (!cacheFilePath) return null;

    if (fs.existsSync(cacheFilePath)) {
        try {
            return await fs.promises.readFile(cacheFilePath);
        } catch (e) {
            reportError(`Error reading cache for ${itemId}:`, e);
        }
    }

    const imagesPath = path.join(libraryPath, "images");
    const itemFolder = resolveItemDir(libraryPath, itemId);
    if (!itemFolder || !fs.existsSync(itemFolder)) return null;

    return coordinator.generate('thumbnail', itemId, cacheFilePath, async () => {
        try {
            const files = (await fs.promises.readdir(itemFolder)).sort();
            let sourceFile = files.find(f => isLibraryThumbnailFile(f));

            if (!sourceFile) {
                const supportedExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif', '.gif', '.avif'];
                sourceFile = files.find(f => {
                    const ext = path.extname(f).toLowerCase();
                    return supportedExts.includes(ext) && f !== 'metadata.json';
                });
            }

            if (!sourceFile) return null;

            const filePath = safeSourcePath(imagesPath, itemFolder, sourceFile);
            if (!filePath) return null;

            return await sharp(filePath)
                .rotate()
                .resize({ height: thumbnailSettings.height })
                .webp({ quality: thumbnailSettings.quality })
                .toBuffer();
        } catch (error) {
            reportError(`Error processing thumbnail for ${itemId}:`, error);
            return null;
        }
    });
}

export async function generatePreview(itemId: string, originalExt: string): Promise<Buffer | null> {
    if (!isSafeItemId(itemId)) return null;
    return generatePreviewBuffer(itemId, originalExt);
}

async function generatePreviewBuffer(itemId: string, originalExt: string): Promise<Buffer | null> {
    if (!libraryPath || !isSafeItemId(itemId) || !originalExt) return null;

    const cacheFilePath = resolveCacheFile(PREVIEW_CACHE_DIR, itemId);
    if (!cacheFilePath) return null;

    if (fs.existsSync(cacheFilePath)) {
        try {
            return await fs.promises.readFile(cacheFilePath);
        } catch (e) {
            reportError(`Error reading preview cache for ${itemId}:`, e);
        }
    }

    const imagesPath = path.join(libraryPath, "images");
    const itemFolder = resolveItemDir(libraryPath, itemId);
    if (!itemFolder || !fs.existsSync(itemFolder)) return null;

    return coordinator.generate('preview', itemId, cacheFilePath, () =>
        producePreview(itemId, originalExt, imagesPath, itemFolder));
}

/** Renders the preview bytes; the coordinator owns caching (atomic write, invalidation fencing). */
async function producePreview(itemId: string, originalExt: string, imagesPath: string, itemFolder: string): Promise<Buffer | null> {
    try {
        const files = (await fs.promises.readdir(itemFolder)).sort();
        const sourceFile = files.find(f => {
            const ext = path.extname(f).toLowerCase();
            return ext === `.${originalExt.toLowerCase()}` && !isAuxiliaryItemFile(f);
        });

        if (!sourceFile) return null;

        const filePath = safeSourcePath(imagesPath, itemFolder, sourceFile);
        if (!filePath) return null;

        try {
            return await sharp(filePath)
                .rotate()
                .resize({ width: 2560, withoutEnlargement: true })
                .webp({ quality: 85 })
                .toBuffer();

        } catch (error: any) {
            if (error.message?.includes('unsupported image format')) {
                // Keep temp extraction local to avoid file locks on network-backed libraries.
                const tempRawPreviewPath = path.join(PREVIEW_CACHE_DIR, `_temp_exiftool_preview_${itemId}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);

                try {
                    let extracted = false;
                    try {
                        await exiftool.extractPreview(filePath, tempRawPreviewPath);
                        extracted = true;
                    } catch (e1) {
                        try {
                            await exiftool.extractJpgFromRaw(filePath, tempRawPreviewPath);
                            extracted = true;
                        } catch (e2) {
                            try {
                                await exiftool.extractThumbnail(filePath, tempRawPreviewPath);
                                extracted = true;
                            } catch (e3) {
                            }
                        }
                    }

                    if (extracted && fs.existsSync(tempRawPreviewPath)) {
                        // Read into memory before Sharp so Windows can release the temp file promptly.
                        const rawBuffer = await fs.promises.readFile(tempRawPreviewPath);

                        let rotationAngle: number | undefined = undefined;
                        try {
                            const tags = await exiftool.readRaw(filePath) as any;
                            const orientationStr = String(tags.Orientation || '');
                            if (orientationStr.includes('90 CW')) rotationAngle = 90;
                            else if (orientationStr.includes('180')) rotationAngle = 180;
                            else if (orientationStr.includes('270 CW')) rotationAngle = 270;
                        } catch (e) { /* ignore */ }

                        let sharpPipeline = sharp(rawBuffer);
                        if (rotationAngle !== undefined) {
                            sharpPipeline = sharpPipeline.rotate(rotationAngle);
                        } else {
                            sharpPipeline = sharpPipeline.rotate();
                        }

                        const fallbackBuffer = await sharpPipeline
                            .resize({ width: 2560, withoutEnlargement: true })
                            .webp({ quality: 85 })
                            .toBuffer();

                        await fs.promises.rm(tempRawPreviewPath, { force: true });

                        return fallbackBuffer;
                    }
                    await fs.promises.rm(tempRawPreviewPath, { force: true });
                } catch (exifError) {
                    await fs.promises.rm(tempRawPreviewPath, { force: true });
                    reportError(`exiftool extract failed for ${itemId}, jumping to library thumbnail...`);
                }

                const fallbackFile = files.find(f => isLibraryThumbnailFile(f));
                const fallbackPath = fallbackFile ? safeSourcePath(imagesPath, itemFolder, fallbackFile) : null;

                if (fallbackPath) {
                    return await sharp(fallbackPath)
                        .rotate()
                        .resize({ width: 2560, withoutEnlargement: true })
                        .webp({ quality: 85 })
                        .toBuffer();
                }
            }

            reportError(`Error processing preview for ${itemId}:`, error);
            return null;
        }
    } catch (fsError) {
        reportError(`Error reading directory for preview ${itemId}:`, fsError);
        return null;
    }
}
