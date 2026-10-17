import { afterEach, describe, expect, test } from "bun:test";
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isAuxiliaryItemFile, isSafeItemId, realFileInside, resolveCacheFile, resolveItemDir, resolveOriginal
} from '../src/lib/mediaPaths';

const dirs: string[] = [];
function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lwv-paths-"));
    dirs.push(d);
    return d;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function makeLibrary() {
    const lib = path.join(tmp(), "Library.library");
    fs.mkdirSync(path.join(lib, "images"), { recursive: true });
    return lib;
}
function writeItem(lib: string, id: string, files: Record<string, string>) {
    const dir = path.join(lib, "images", `${id}.info`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
}

describe("isSafeItemId", () => {
    test("accepts ordinary and unverified-charset ids", () => {
        for (const id of ["KABC123DEF456", "abc", "a-b_c", "id with space", "x.y", "ÄÖ"]) expect(isSafeItemId(id)).toBe(true);
    });

    test("rejects traversal, separators, dots, NUL, absolute and encoded forms", () => {
        const bad = [
            "", ".", "..", "../x", "..\\x", "a/b", "a\\b", "/abs", "C:\\abs", "C:", "a\0b", "..%2f", "%2e%2e", "%2E%2E%2F",
            "..%5c", "a:stream", "trail.", " lead", "trail ", "CON", "nul.webp", "aux", "a|b", "a*b", "a?b", "a\nb"
        ];
        for (const id of bad) expect([id, isSafeItemId(id)]).toEqual([id, false]);
    });

    test("rejects non-strings and overlong ids", () => {
        for (const v of [undefined, null, 5, {}, []]) expect(isSafeItemId(v)).toBe(false);
        expect(isSafeItemId("a".repeat(256))).toBe(false);
    });
});

describe("contained resolution", () => {
    test("cache and item dir paths stay inside their roots; unsafe ids resolve to null", () => {
        const root = tmp();
        expect(resolveCacheFile(root, "abc")).toBe(path.join(root, "abc.webp"));
        expect(resolveCacheFile(root, "..")).toBeNull();
        expect(resolveCacheFile(root, "..\\..\\evil")).toBeNull();
        const lib = makeLibrary();
        expect(resolveItemDir(lib, "abc")).toBe(path.join(lib, "images", "abc.info"));
        expect(resolveItemDir(lib, "../abc")).toBeNull();
        expect(resolveItemDir("", "abc")).toBeNull();
    });

    test("auxiliary file detection", () => {
        for (const f of ["metadata.json", "METADATA.JSON", "a_thumbnail.png", "a_thumbnail.JPG"]) expect(isAuxiliaryItemFile(f)).toBe(true);
        for (const f of ["a.png", "thumbnail.png", "a.json"]) expect(isAuxiliaryItemFile(f)).toBe(false);
    });

    test("realFileInside rejects directories and missing files", () => {
        const lib = makeLibrary();
        const dir = writeItem(lib, "a", { "a.png": "x" });
        const images = path.join(lib, "images");
        expect(realFileInside(images, path.join(dir, "a.png"))).not.toBeNull();
        expect(realFileInside(images, dir)).toBeNull();
        expect(realFileInside(images, path.join(dir, "missing.png"))).toBeNull();
    });

    test("symlink escaping the images root is rejected (skipped when symlinks are not permitted)", () => {
        const lib = makeLibrary();
        const outside = path.join(tmp(), "secret.png");
        fs.writeFileSync(outside, "secret");
        const dir = writeItem(lib, "a", {});
        try {
            fs.symlinkSync(outside, path.join(dir, "a.png"), "file");
        } catch (e: any) {
            if (e?.code === "EPERM" || e?.code === "EACCES") {
                console.warn("SKIPPED symlink test: symlink creation not permitted here");
                return;
            }
            throw e;
        }
        expect(realFileInside(path.join(lib, "images"), path.join(dir, "a.png"))).toBeNull();
        expect(resolveOriginal(lib, "a", "png", "a.png")).toEqual({ kind: "not_found" });
    });
});

describe("resolveOriginal recoveryOnly", () => {
    test("never selects a real file resembling the placeholder when several candidates exist", () => {
        const lib = makeLibrary();
        writeItem(lib, "a", { "original.png": "C", "actual.png": "A" });
        expect(resolveOriginal(lib, "a", "png", "original.png", { recoveryOnly: true })).toEqual({ kind: "ambiguous" });
        // the normal contract is untouched: exact name wins
        expect(resolveOriginal(lib, "a", "png", "original.png").kind).toBe("ok");
    });

    test("serves the sole eligible original regardless of the requested name", () => {
        const lib = makeLibrary();
        const dir = writeItem(lib, "a", { "only.png": "x", "metadata.json": "{}", "only_thumbnail.png": "t" });
        const r = resolveOriginal(lib, "a", "png", "ignored", { recoveryOnly: true });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") expect(fs.realpathSync(r.path)).toBe(fs.realpathSync(path.join(dir, "only.png")));
    });

    test("none -> not_found; invalid item -> not_found", () => {
        const lib = makeLibrary();
        writeItem(lib, "a", { "metadata.json": "{}" });
        expect(resolveOriginal(lib, "a", "png", "x", { recoveryOnly: true })).toEqual({ kind: "not_found" });
        expect(resolveOriginal(lib, "..", "png", "x", { recoveryOnly: true })).toEqual({ kind: "not_found" });
    });
});

describe("resolveOriginal", () => {
    test("serves the exact requested file", () => {
        const lib = makeLibrary();
        const dir = writeItem(lib, "a", { "pic.png": "x", "metadata.json": "{}", "pic_thumbnail.png": "t" });
        const r = resolveOriginal(lib, "a", "png", "pic.png");
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") expect(fs.realpathSync(r.path)).toBe(fs.realpathSync(path.join(dir, "pic.png")));
    });

    test("recovers a renamed original only when exactly one same-extension candidate exists", () => {
        const lib = makeLibrary();
        writeItem(lib, "a", { "actual.png": "x", "metadata.json": "{}", "actual_thumbnail.png": "t" });
        const r = resolveOriginal(lib, "a", "png", "stale name.png");
        expect(r.kind).toBe("ok");
    });

    test("ambiguous recovery fails instead of substituting", () => {
        const lib = makeLibrary();
        writeItem(lib, "a", { "one.png": "1", "two.png": "2", "metadata.json": "{}" });
        expect(resolveOriginal(lib, "a", "png", "gone.png")).toEqual({ kind: "ambiguous" });
        // an exact match is still served
        expect(resolveOriginal(lib, "a", "png", "two.png").kind).toBe("ok");
    });

    test("never returns metadata.json, library thumbnails, other extensions or directories", () => {
        const lib = makeLibrary();
        const dir = writeItem(lib, "a", { "metadata.json": "{}", "x_thumbnail.png": "t", "note.txt": "n" });
        fs.mkdirSync(path.join(dir, "sub.png"));
        for (const name of ["metadata.json", "x_thumbnail.png", "note.txt", "sub.png", "../metadata.json", "a/b.png", "..", ""]) {
            expect([name, resolveOriginal(lib, "a", "png", name).kind]).toEqual([name, "not_found"]);
        }
    });

    // Detect case sensitivity explicitly with two probe files differing only in case
    function caseSensitiveFs(): boolean {
        const d = tmp();
        fs.writeFileSync(path.join(d, "probe.txt"), "a");
        fs.writeFileSync(path.join(d, "PROBE.txt"), "b");
        return fs.readdirSync(d).length === 2;
    }

    test("case variants: exact requests pick their own file; a third variant is ambiguous (case-sensitive FS only)", () => {
        const lib = makeLibrary();
        if (!caseSensitiveFs()) {
            console.warn("SKIPPED case-variant ambiguity test: filesystem is case-insensitive");
            // single file: case-insensitive request still resolves to it
            const dir = writeItem(lib, "a", { "Photo.png": "x" });
            const r = resolveOriginal(lib, "a", "png", "photo.png");
            expect(r.kind).toBe("ok");
            if (r.kind === "ok") expect(fs.readFileSync(r.path, "utf8")).toBe("x");
            expect(fs.existsSync(dir)).toBe(true);
            return;
        }
        writeItem(lib, "a", { "Photo.png": "lower-p", "PHOTO.png": "upper" });
        const read = (name: string) => {
            const r = resolveOriginal(lib, "a", "png", name);
            return r.kind === "ok" ? fs.readFileSync(r.path, "utf8") : r.kind;
        };
        expect(read("Photo.png")).toBe("lower-p");
        expect(read("PHOTO.png")).toBe("upper");
        expect(read("photo.png")).toBe("ambiguous");
    });

    test("unique case-insensitive match is served", () => {
        const lib = makeLibrary();
        writeItem(lib, "a", { "Photo.png": "p", "other.png": "o" });
        const r = resolveOriginal(lib, "a", "png", "PHOTO.PNG");
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") expect(fs.readFileSync(r.path, "utf8")).toBe("p");
    });

    test("directory with the original's extension is not a recovery candidate", () => {
        const lib = makeLibrary();
        const dir = writeItem(lib, "a", { "real.png": "REAL" });
        fs.mkdirSync(path.join(dir, "other.png"));
        const r = resolveOriginal(lib, "a", "png", "stale.png");
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") expect(fs.readFileSync(r.path, "utf8")).toBe("REAL");
    });

    test("escaping symlink is not a recovery candidate (skipped when symlinks are not permitted)", () => {
        const lib = makeLibrary();
        const outside = path.join(tmp(), "secret.png");
        fs.writeFileSync(outside, "SECRET");
        const dir = writeItem(lib, "a", { "real.png": "REAL" });
        try {
            fs.symlinkSync(outside, path.join(dir, "link.png"), "file");
        } catch (e: any) {
            if (e?.code === "EPERM" || e?.code === "EACCES") {
                console.warn("SKIPPED symlink recovery test: symlink creation not permitted here");
                return;
            }
            throw e;
        }
        const r = resolveOriginal(lib, "a", "png", "stale.png");
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") expect(fs.readFileSync(r.path, "utf8")).toBe("REAL");
    });

    test("zero eligible candidates (only directories / auxiliary files) -> not_found", () => {
        const lib = makeLibrary();
        const dir = writeItem(lib, "a", { "metadata.json": "{}", "x_thumbnail.png": "t" });
        fs.mkdirSync(path.join(dir, "sub.png"));
        expect(resolveOriginal(lib, "a", "png", "stale.png")).toEqual({ kind: "not_found" });
    });

    test("unsafe item ids are not found", () => {
        const lib = makeLibrary();
        writeItem(lib, "a", { "pic.png": "x" });
        expect(resolveOriginal(lib, "..", "png", "pic.png").kind).toBe("not_found");
        expect(resolveOriginal(lib, "a/../a", "png", "pic.png").kind).toBe("not_found");
    });
});
