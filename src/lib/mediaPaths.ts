import fs from 'fs';
import path from 'path';

/**
 * Safe path construction for item media. Pure helpers with no import-time side
 * effects: every function validates its own inputs, so callers never rely on a
 * route having checked first. Nothing here writes to the filesystem.
 */

const MAX_COMPONENT_LENGTH = 255;
// Windows device names resolve to devices regardless of extension ("CON.webp")
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Structural validation only (no Eagle id charset/length rule): an item id must
 * be exactly one harmless path component on every platform.
 */
export function isSafeItemId(id: unknown): id is string {
    if (typeof id !== 'string') return false;
    if (id.length === 0 || id.length > MAX_COMPONENT_LENGTH) return false;
    if (id === '.' || id === '..') return false;
    if (/[\/\\\0:*?"<>|]/.test(id)) return false;       // separators, NUL, drive/stream/wildcard characters
    if (/[\u0000-\u001f\u007f]/.test(id)) return false;  // control characters
    if (/%[0-9a-f]{2}/i.test(id)) return false;          // percent-encoded escape forms
    if (id !== id.trim() || id.endsWith('.')) return false; // Windows silently strips these
    if (RESERVED_DEVICE_NAME.test(id)) return false;
    return true;
}

/** True when `child` is strictly inside `root` (both already absolute). */
function isInside(root: string, child: string): boolean {
    const rel = path.relative(root, child);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** Lexical containment: `<root>/<name>` for a single safe component, else null. */
export function resolveChild(root: string, name: string): string | null {
    if (!root || !isSafeItemId(name)) return null;
    const resolvedRoot = path.resolve(root);
    const full = path.resolve(resolvedRoot, name);
    return isInside(resolvedRoot, full) ? full : null;
}

/** `<cacheDir>/<id>.webp`, or null for an unsafe id. */
export function resolveCacheFile(cacheDir: string, itemId: string): string | null {
    if (!isSafeItemId(itemId)) return null;
    return resolveChild(cacheDir, `${itemId}.webp`);
}

/** `<libraryPath>/images/<id>.info`, or null for an unsafe id / missing library. */
export function resolveItemDir(libraryPath: string, itemId: string): string | null {
    if (!libraryPath || !isSafeItemId(itemId)) return null;
    return resolveChild(path.join(libraryPath, 'images'), `${itemId}.info`);
}

/**
 * Real path of `file` when it is an existing regular file whose realpath stays
 * inside the realpath of `root` (rejects symlink/junction escapes). Null for
 * anything else, including missing files and any filesystem error.
 */
export function realFileInside(root: string, file: string): string | null {
    try {
        const realRoot = fs.realpathSync(root);
        const realFile = fs.realpathSync(file);
        if (!isInside(realRoot, realFile)) return null;
        return fs.statSync(realFile).isFile() ? realFile : null;
    } catch {
        return null;
    }
}

/** metadata.json and library-generated thumbnails are never "the original". */
export function isAuxiliaryItemFile(fileName: string): boolean {
    return /^metadata\.json$/i.test(fileName) || /_thumbnail\.[^.]+$/i.test(fileName);
}

export function isLibraryThumbnailFile(fileName: string): boolean {
    return /_thumbnail\.(png|jpg)$/i.test(fileName);
}

/** A single filename component supplied by a client (no separators, dots, NUL...). */
export function isSafeFileName(name: unknown): name is string {
    // Looser than an id (names may hold spaces, ':' etc.); safe because the name is
    // only ever matched against real directory entries, never joined blindly.
    return typeof name === 'string'
        && name.length > 0 && name.length <= MAX_COMPONENT_LENGTH
        && name !== '.' && name !== '..'
        && !/[\/\\\0]/.test(name);
}

export type OriginalResolution =
    | { kind: 'ok'; path: string }
    | { kind: 'not_found' }
    | { kind: 'ambiguous' };

function extMatches(fileName: string, ext: string): boolean {
    return path.extname(fileName).toLowerCase() === `.${ext.toLowerCase()}`;
}

/**
 * Deterministic same-item original resolution inside `<images>/<id>.info`.
 * Candidates are non-auxiliary, item-extension, contained regular files; then:
 *  1. a valid exact-name match is served;
 *  2. otherwise case-insensitive matches: exactly one is served, several -> ambiguous;
 *  3. otherwise (stale name) the sole candidate is served;
 *  4. several candidates -> ambiguous, none -> not_found (never an arbitrary pick).
 * Limitation: `*_thumbnail.<ext>` exclusion is this batch's convention, not
 * proven Eagle naming behavior. A requested name that is itself an ineligible
 * entry (e.g. an escaping symlink) falls through to step 3 like any stale name.
 */
export function resolveOriginal(
    libraryPath: string,
    itemId: string,
    ext: string,
    requestedName: string
): OriginalResolution {
    const itemDir = resolveItemDir(libraryPath, itemId);
    if (!itemDir || !ext || !isSafeFileName(requestedName)) return { kind: 'not_found' };
    if (isAuxiliaryItemFile(requestedName)) return { kind: 'not_found' };

    let entries: string[];
    try {
        entries = fs.readdirSync(itemDir);
    } catch {
        return { kind: 'not_found' };
    }

    let realItemDir: string;
    try {
        realItemDir = fs.realpathSync(itemDir);
    } catch {
        return { kind: 'not_found' };
    }
    const imagesRoot = path.join(libraryPath, 'images');

    // Candidates are CONTAINED REGULAR FILES only (images-root and own-item-dir
    // containment by realpath; directories and escaping symlinks drop out here),
    // so ambiguity is computed over files that could actually be served.
    const eligible: { name: string; real: string }[] = [];
    for (const name of entries.filter(f => !isAuxiliaryItemFile(f) && extMatches(f, ext)).sort()) {
        const real = realFileInside(imagesRoot, path.join(itemDir, name));
        if (real && isInside(realItemDir, real)) eligible.push({ name, real });
    }

    // Matching is against real directory entries (not a joined path) so case/8.3 tricks can't pick another name
    // 1. valid exact match
    const exact = eligible.find(c => c.name === requestedName);
    if (exact) return { kind: 'ok', path: exact.real };

    // 2./3. case-insensitive matches: serve only a unique one (case-sensitive filesystems can hold several)
    const lower = requestedName.toLowerCase();
    const caseMatches = eligible.filter(c => c.name.toLowerCase() === lower);
    if (caseMatches.length === 1) return { kind: 'ok', path: caseMatches[0].real };
    if (caseMatches.length > 1) return { kind: 'ambiguous' };

    // 4. stale-name recovery: the item's sole eligible original
    if (eligible.length === 1) return { kind: 'ok', path: eligible[0].real };
    return { kind: eligible.length > 1 ? 'ambiguous' : 'not_found' };
}
