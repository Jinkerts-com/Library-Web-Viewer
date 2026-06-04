
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { exiftool } from 'exiftool-vendored';
import { libraryPath } from './db';

export const CACHE_DIR = path.join(process.cwd(), 'db', 'cache', 'thumbnails');
export const PREVIEW_CACHE_DIR = path.join(process.cwd(), 'db', 'cache', 'previews');
const previewJobs = new Map<string, Promise<Buffer | null>>();

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(PREVIEW_CACHE_DIR)) {
    fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });
}

export function deleteItemCache(itemId: string) {
    try {
        const thumbPath = path.join(CACHE_DIR, `${itemId}.webp`);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

        const previewPath = path.join(PREVIEW_CACHE_DIR, `${itemId}.webp`);
        if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
    } catch (e) {
        console.error(`Failed to delete cache for ${itemId}:`, e);
    }
}

export async function generateThumbnail(itemId: string): Promise<Buffer | null> {
    if (!libraryPath || !itemId) return null;

    const cacheFilePath = path.join(CACHE_DIR, `${itemId}.webp`);

    if (fs.existsSync(cacheFilePath)) {
        try {
            return await fs.promises.readFile(cacheFilePath);
        } catch (e) {
            console.error(`Error reading cache for ${itemId}:`, e);
        }
    }

    const imagesPath = path.join(libraryPath, "images");
    const itemFolder = path.join(imagesPath, itemId + ".info");

    if (!fs.existsSync(itemFolder)) return null;

    try {
        const files = await fs.promises.readdir(itemFolder);
        let sourceFile = files.find(f => f.endsWith("_thumbnail.png") || f.endsWith("_thumbnail.jpg"));

        if (!sourceFile) {
            const supportedExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif', '.gif', '.avif'];
            sourceFile = files.find(f => {
                const ext = path.extname(f).toLowerCase();
                return supportedExts.includes(ext) && f !== 'metadata.json';
            });
        }

        if (!sourceFile) return null;

        const filePath = path.join(itemFolder, sourceFile);

        const optimizedBuffer = await sharp(filePath)
            .rotate()
            .resize({ height: parseInt(process.env.THUMBNAIL_HEIGHT || '400', 10) })
            .webp({ quality: parseInt(process.env.THUMBNAIL_QUALITY || '80', 10) })
            .toBuffer();

        await fs.promises.writeFile(cacheFilePath, optimizedBuffer);

        return optimizedBuffer;
    } catch (error) {
        console.error(`Error processing thumbnail for ${itemId}:`, error);
        return null;
    }
}

export async function generatePreview(itemId: string, originalExt: string): Promise<Buffer | null> {
    const existingJob = previewJobs.get(itemId);
    if (existingJob) return existingJob;

    const job = generatePreviewBuffer(itemId, originalExt).finally(() => {
        previewJobs.delete(itemId);
    });
    previewJobs.set(itemId, job);
    return job;
}

async function generatePreviewBuffer(itemId: string, originalExt: string): Promise<Buffer | null> {
    if (!libraryPath || !itemId || !originalExt) return null;

    const cacheFilePath = path.join(PREVIEW_CACHE_DIR, `${itemId}.webp`);

    if (fs.existsSync(cacheFilePath)) {
        try {
            return await fs.promises.readFile(cacheFilePath);
        } catch (e) {
            console.error(`Error reading preview cache for ${itemId}:`, e);
        }
    }

    const imagesPath = path.join(libraryPath, "images");
    const itemFolder = path.join(imagesPath, itemId + ".info");

    if (!fs.existsSync(itemFolder)) return null;

    try {
        const files = await fs.promises.readdir(itemFolder);
        const sourceFile = files.find(f => {
            const ext = path.extname(f).toLowerCase();
            return ext === `.${originalExt.toLowerCase()}` && f !== 'metadata.json' && !f.endsWith('_thumbnail.png') && !f.endsWith('_thumbnail.jpg');
        });

        if (!sourceFile) return null;

        const filePath = path.join(itemFolder, sourceFile);

        try {
            const optimizedBuffer = await sharp(filePath)
                .rotate()
                .resize({ width: 2560, withoutEnlargement: true })
                .webp({ quality: 85 })
                .toBuffer();

            await fs.promises.writeFile(cacheFilePath, optimizedBuffer);
            return optimizedBuffer;

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

                        await fs.promises.writeFile(cacheFilePath, fallbackBuffer);
                        return fallbackBuffer;
                    }
                    await fs.promises.rm(tempRawPreviewPath, { force: true });
                } catch (exifError) {
                    await fs.promises.rm(tempRawPreviewPath, { force: true });
                    console.error(`exiftool extract failed for ${itemId}, jumping to library thumbnail...`);
                }

                const fallbackFile = files.find(f => f.endsWith('_thumbnail.png') || f.endsWith('_thumbnail.jpg'));

                if (fallbackFile) {
                    const fallbackPath = path.join(itemFolder, fallbackFile);
                    const fallbackBuffer = await sharp(fallbackPath)
                        .rotate()
                        .resize({ width: 2560, withoutEnlargement: true })
                        .webp({ quality: 85 })
                        .toBuffer();

                    await fs.promises.writeFile(cacheFilePath, fallbackBuffer);
                    return fallbackBuffer;
                }
            }

            console.error(`Error processing preview for ${itemId}:`, error);
            return null;
        }
    } catch (fsError) {
        console.error(`Error reading directory for preview ${itemId}:`, fsError);
        return null;
    }
}
