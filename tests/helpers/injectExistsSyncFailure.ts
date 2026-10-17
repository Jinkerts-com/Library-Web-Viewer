// Bun --preload used by subprocess tests: makes fs.existsSync throw for the cache file of the
// item named BAD. generateThumbnail checks that path outside its own try/catch, so this
// deterministically produces a *caught per-item error* in scripts/generate_thumbnails.ts
// without touching production code.
import fs from 'fs';

const original = fs.existsSync;
fs.existsSync = ((p: fs.PathLike) => {
    if (String(p).endsWith("BAD.webp")) throw new Error("injected existsSync failure");
    return original(p);
}) as typeof fs.existsSync;
