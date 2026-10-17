import { describe, expect, test } from "bun:test";
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Source edit -> derived regeneration through the production wiring. db.ts reads
 * LIBRARY_PATH and opens <cwd>/db at import time, so the scenario runs in a
 * subprocess whose cwd and library are disposable temp directories (the workspace
 * db/ and the real library are never touched).
 */
describe("source edit regenerates thumbnails and previews (production wiring)", () => {
    test("changed original -> watcher invalidation -> new WebP bytes, ETag and cache files; sources untouched", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "lwv-regen-"));
        try {
            const libraryPath = path.join(root, "Library.library");
            const cwd = path.join(root, "work");
            fs.mkdirSync(libraryPath, { recursive: true });
            fs.mkdirSync(cwd, { recursive: true });

            const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "helpers", "regenerationScenario.ts")], {
                cwd,
                env: { ...process.env, LIBRARY_PATH: libraryPath, VERBOSE: "false" },
                stdout: "pipe",
                stderr: "pipe"
            });
            const [stdout, stderr, code] = await Promise.all([
                new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
            ]);
            if (code !== 0) throw new Error(`scenario exited ${code}\n${stderr}\n${stdout}`);

            const line = stdout.split(/\r?\n/).find(l => l.startsWith("RESULT:"));
            expect(line).toBeTruthy();
            const r = JSON.parse(line!.slice("RESULT:".length));

            expect(r.scanOutcome).toBe("success");
            for (const kind of ["thumbnail", "preview"] as const) {
                // generated and cached: red WebP
                expect(r.before[kind].status).toBe(200);
                expect(r.before[kind].contentType).toBe("image/webp");
                expect(r.before[kind].red).toBeGreaterThan(r.before[kind].blue);
                // source edited but no event yet: the cached bytes are still served
                expect(r.stale[kind].etag).toBe(r.before[kind].etag);
                // after the watcher event: regenerated from the edited source
                expect(r.after[kind].status).toBe(200);
                expect(r.after[kind].contentType).toBe("image/webp");
                expect(r.after[kind].blue).toBeGreaterThan(r.after[kind].red);
                expect(r.after[kind].etag).not.toBe(r.before[kind].etag);
                expect(r.after[kind].sha).not.toBe(r.before[kind].sha);
                // the cache FILES were rewritten, not just the response
                expect(r.cachedAfter[kind]).not.toBe(r.cachedBefore[kind]);
                expect(r.cachedAfter[kind]).toBe(r.after[kind].sha);
            }
            expect(r.cacheGone).toBe(true); // invalidation removed both cache files before the re-request

            // Library sources: generation never wrote; only the deliberate edit differs
            expect(r.sourcesBefore["metadata.json"]).toBe(r.sourcesAfter["metadata.json"]);
            expect(r.sourcesBefore[path.join("images", "ITEM1.info", "metadata.json")]).toBe(r.sourcesAfter[path.join("images", "ITEM1.info", "metadata.json")]);
            expect(r.sourcesEdited).toEqual(r.sourcesAfter);
            expect(r.sourcesBefore[path.join("images", "ITEM1.info", "pic.png")]).not.toBe(r.sourcesAfter[path.join("images", "ITEM1.info", "pic.png")]);

            // Derived files landed under the subprocess cwd only
            expect(fs.existsSync(path.join(cwd, "db", "cache", "thumbnails", "ITEM1.webp"))).toBe(true);
            expect(fs.existsSync(path.join(cwd, "db", "cache", "previews", "ITEM1.webp"))).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);
});
