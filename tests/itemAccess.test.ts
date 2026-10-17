import { afterEach, describe, expect, test } from "bun:test";
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    authorizeItem, effectiveLockedFolderIds, parseFolderMembership,
    type AccessDeps, type AccessItem, type FolderNode, type LockState
} from '../src/lib/itemAccess';
import { getUnlockedFolderIds, unlockCookie } from '../src/lib/unlock';
import { createOriginalHandler, createPreviewHandler, createThumbnailHandler } from '../src/lib/mediaHandlers';

// Tree: root(locked) > child(inherits lock) > grandchild ; sibling(locked) ; open(unlocked)
const folders: FolderNode[] = [
    { id: "root", children: [{ id: "child", children: [{ id: "grand", children: [] }] }] },
    { id: "sibling", children: [] },
    { id: "open", children: [] }
];
const lockedFolderIds = new Set(["root", "child", "grand", "sibling"]);

const items: Record<string, AccessItem> = {
    inRoot: { id: "inRoot", name: "a", ext: "png", folders: ["root"] },
    inChild: { id: "inChild", name: "b", ext: "png", folders: ["child"] },
    inSibling: { id: "inSibling", name: "c", ext: "png", folders: ["sibling"] },
    inOpen: { id: "inOpen", name: "d", ext: "png", folders: ["open"] },
    multi: { id: "multi", name: "e", ext: "png", folders: ["open", "sibling"] },
    loose: { id: "loose", name: "f", ext: "png", folders: [] }
};

function makeDeps(ready = true): AccessDeps & { state: LockState } {
    const state: LockState = { ready, folders, lockedFolderIds };
    return { state, getLockState: () => state, lookupItem: (id) => items[id] ?? null };
}

function req(...unlocked: string[]): Request {
    const cookie = unlocked.map(id => unlockCookie(id).split(';')[0]).join('; ');
    return new Request("http://localhost/x", cookie ? { headers: { cookie } } : {});
}

describe("effectiveLockedFolderIds", () => {
    test("not ready -> null (never 'nothing locked')", () => {
        expect(effectiveLockedFolderIds({ ready: false, folders: [], lockedFolderIds: new Set() }, [])).toBeNull();
    });

    test("unlocking a folder unlocks its subtree only", () => {
        const eff = effectiveLockedFolderIds({ ready: true, folders, lockedFolderIds }, ["root"])!;
        expect([...eff].sort()).toEqual(["sibling"]);
        const childOnly = effectiveLockedFolderIds({ ready: true, folders, lockedFolderIds }, ["child"])!;
        expect([...childOnly].sort()).toEqual(["root", "sibling"]);
    });

    test("unknown unlocked ids are ignored", () => {
        const eff = effectiveLockedFolderIds({ ready: true, folders, lockedFolderIds }, ["nope"])!;
        expect(eff.size).toBe(lockedFolderIds.size);
    });
});

describe("authorizeItem", () => {
    test("unlocked and folderless items are allowed without cookies", () => {
        const deps = makeDeps();
        expect(authorizeItem(deps, req(), "inOpen").ok).toBe(true);
        expect(authorizeItem(deps, req(), "loose").ok).toBe(true);
    });

    test("locked items denied without cookie, allowed with own or ancestor cookie, sibling cookie does not unlock", () => {
        const deps = makeDeps();
        expect(authorizeItem(deps, req(), "inChild")).toEqual({ ok: false, status: 404 });
        expect(authorizeItem(deps, req("child"), "inChild").ok).toBe(true);
        expect(authorizeItem(deps, req("root"), "inChild").ok).toBe(true);
        expect(authorizeItem(deps, req("sibling"), "inChild").ok).toBe(false);
        expect(authorizeItem(deps, req("root"), "inSibling").ok).toBe(false);
    });

    test("multi-folder item needs every locked membership unlocked", () => {
        const deps = makeDeps();
        expect(authorizeItem(deps, req(), "multi").ok).toBe(false);
        expect(authorizeItem(deps, req("root"), "multi").ok).toBe(false);
        expect(authorizeItem(deps, req("sibling"), "multi").ok).toBe(true);
    });

    test("forged cookie signatures do not unlock", () => {
        const forged = new Request("http://localhost/x", { headers: { cookie: "unlocked_root=deadbeef" } });
        expect(authorizeItem(makeDeps(), forged, "inRoot").ok).toBe(false);
    });

    test("unknown id looks identical to a locked id", () => {
        const deps = makeDeps();
        expect(authorizeItem(deps, req(), "doesNotExist")).toEqual(authorizeItem(deps, req(), "inRoot"));
    });

    test("unsafe ids are denied before any lookup", () => {
        let looked = 0;
        const deps = { ...makeDeps(), lookupItem: () => { looked++; return items.loose; } };
        for (const id of ["..", "a/b", "a\\b", "..%2f", "a\0b", undefined]) expect(authorizeItem(deps, req(), id).ok).toBe(false);
        expect(looked).toBe(0);
    });

    test("fail-closed until lock metadata is ready, correct afterwards", () => {
        const deps = makeDeps(false);
        expect(authorizeItem(deps, req(), "inOpen")).toEqual({ ok: false, status: 503 });
        expect(authorizeItem(deps, req(), "inRoot")).toEqual({ ok: false, status: 503 });
        deps.state.ready = true;
        expect(authorizeItem(deps, req(), "inOpen").ok).toBe(true);
        expect(authorizeItem(deps, req(), "inRoot").ok).toBe(false);
    });

    test("lookup or lock-state errors deny", () => {
        const throwingLookup = { ...makeDeps(), lookupItem: () => { throw new Error("db"); } };
        expect(authorizeItem(throwingLookup, req(), "inOpen").ok).toBe(false);
        const throwingState = { ...makeDeps(), getLockState: () => { throw new Error("state"); } };
        expect(authorizeItem(throwingState, req(), "inOpen").ok).toBe(false);
    });
});

describe("parseFolderMembership", () => {
    test("parses arrays, tolerates empty, rejects malformed", () => {
        expect(parseFolderMembership('["a","b"]')).toEqual(["a", "b"]);
        expect(parseFolderMembership(null)).toEqual([]);
        expect(parseFolderMembership('{"a":1}')).toBeNull();
        expect(parseFolderMembership('[1]')).toBeNull();
        expect(parseFolderMembership('not json')).toBeNull();
    });
});

describe("malformed cookies", () => {
    test("bad percent-encoding in a cookie name is ignored and valid cookies still count", () => {
        const good = unlockCookie("open").split(';')[0];
        const r = new Request("http://localhost/x", { headers: { cookie: `unlocked_%E0%A4%A=abc; ${good}; unlocked_%=x` } });
        expect(() => getUnlockedFolderIds(r)).not.toThrow();
        expect([...getUnlockedFolderIds(r)]).toEqual(["open"]);
    });

    test("authorization still works with a malformed cookie present", () => {
        const r = new Request("http://localhost/x", { headers: { cookie: "unlocked_%E0%A4%A=abc" } });
        expect(authorizeItem(makeDeps(), r, "inOpen").ok).toBe(true);
        expect(authorizeItem(makeDeps(), r, "inRoot").ok).toBe(false);
    });
});

// ---- route handlers (factories over injected deps; no production DB) ----

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function ctx(id: string | undefined, request: Request, pathParam?: string) {
    return { params: { id, path: pathParam }, request } as any;
}

describe("thumbnail / preview handlers", () => {
    test("denied requests never touch the generator (cache hit cannot bypass the check)", async () => {
        const cached = Buffer.from("CACHED-THUMB");
        let calls = 0;
        const handler = createThumbnailHandler({
            access: makeDeps(), generateThumbnail: async () => { calls++; return cached; }
        });

        // authorized: served from cache
        const ok = await handler(ctx("inRoot", req("root")));
        expect(ok.status).toBe(200);
        expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("CACHED-THUMB");
        expect(calls).toBe(1);

        // same item, client has no unlock now: denied, generator (cache) not consulted
        const denied = await handler(ctx("inRoot", req()));
        expect(denied.status).toBe(404);
        expect(await denied.text()).not.toContain("CACHED");
        expect(calls).toBe(1);

        // unknown id is indistinguishable
        const unknown = await handler(ctx("nope", req()));
        expect(unknown.status).toBe(denied.status);
        expect(await unknown.text()).toBe("Not found");
        expect(calls).toBe(1);
    });

    test("authorized item without a thumbnail still gets the placeholder", async () => {
        const handler = createThumbnailHandler({ access: makeDeps(), generateThumbnail: async () => null });
        const res = await handler(ctx("inOpen", req()));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/svg+xml");
    });

    test("not-ready lock metadata denies thumbnails and previews; prepare runs first", async () => {
        const deps = makeDeps(false);
        let gen = 0;
        const prepared: string[] = [];
        const thumb = createThumbnailHandler({
            access: deps, prepare: async () => { prepared.push("t"); }, generateThumbnail: async () => { gen++; return Buffer.from("x"); }
        });
        const prev = createPreviewHandler({ access: deps, generatePreview: async () => { gen++; return Buffer.from("x"); } });
        expect((await thumb(ctx("inOpen", req()))).status).toBe(503);
        expect((await prev(ctx("inOpen", req()))).status).toBe(503);
        expect(gen).toBe(0);
        expect(prepared).toEqual(["t"]);

        deps.state.ready = true;
        expect((await thumb(ctx("inOpen", req()))).status).toBe(200);
        expect((await prev(ctx("inOpen", req()))).status).toBe(200);
    });

    test("preview: locked denied, ancestor cookie allowed, generator receives the DB ext", async () => {
        const seen: string[] = [];
        const prev = createPreviewHandler({
            access: makeDeps(), generatePreview: async (id, ext) => { seen.push(`${id}.${ext}`); return Buffer.from("P"); }
        });
        expect((await prev(ctx("inChild", req()))).status).toBe(404);
        expect((await prev(ctx("inChild", req("sibling")))).status).toBe(404);
        expect((await prev(ctx("inChild", req("root")))).status).toBe(200);
        expect(seen).toEqual(["inChild.png"]);
    });
});

describe("original handler", () => {
    function setup() {
        const lib = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lwv-orig-")), "Library.library");
        dirs.push(path.dirname(lib));
        const write = (id: string, files: Record<string, string>) => {
            const d = path.join(lib, "images", `${id}.info`);
            fs.mkdirSync(d, { recursive: true });
            for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
        };
        write("inRoot", { "a.png": "ROOT-ORIGINAL", "metadata.json": '{"secret":1}', "a_thumbnail.png": "T" });
        write("inOpen", { "d.png": "OPEN-ORIGINAL", "metadata.json": "{}" });
        write("multi", { "one.png": "1", "two.png": "2" });
        const handler = createOriginalHandler({ access: makeDeps(), getLibraryPath: () => lib });
        return { lib, handler };
    }

    test("authorized original served; locked denied; unknown looks the same", async () => {
        const { handler } = setup();
        const ok = await handler(ctx(undefined, req(), "inOpen.info/d.png"));
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("OPEN-ORIGINAL");

        const locked = await handler(ctx(undefined, req(), "inRoot.info/a.png"));
        const unknown = await handler(ctx(undefined, req(), "ghost.info/a.png"));
        expect(locked.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(await locked.text()).toBe(await unknown.text());

        expect((await handler(ctx(undefined, req("sibling"), "inRoot.info/a.png"))).status).toBe(404);
        const viaAncestor = await handler(ctx(undefined, req("root"), "inRoot.info/a.png"));
        expect(await viaAncestor.text()).toBe("ROOT-ORIGINAL");
    });

    test("metadata.json and library thumbnails are rejected even for authorized clients", async () => {
        const { handler } = setup();
        for (const p of ["inRoot.info/metadata.json", "inRoot.info/a_thumbnail.png", "inOpen.info/metadata.json"]) {
            const res = await handler(ctx(undefined, req("root"), p));
            expect([p, res.status]).toEqual([p, 404]);
        }
    });

    test("traversal forms are rejected", async () => {
        const { handler } = setup();
        const paths = [
            "../metadata.json", "inOpen.info/../inRoot.info/a.png", "..%2f..%2fmetadata.json", "%2e%2e/%2e%2e/x",
            "inOpen.info\\..\\inRoot.info\\a.png", "inOpen.info/d.png/../../x", "/etc/passwd", "C:/Windows/win.ini", "inOpen.info/", "inOpen.info"
        ];
        for (const p of paths) {
            const res = await handler(ctx(undefined, req(), p));
            expect([p, res.status === 200 && (await res.clone().text()).includes("ORIGINAL")]).toEqual([p, false]);
        }
    });

    test("ambiguous recovery returns 409; single candidate recovers", async () => {
        const { handler, lib } = setup();
        expect((await handler(ctx(undefined, req("sibling"), "multi.info/gone.png"))).status).toBe(409);
        const res = await handler(ctx(undefined, req(), "inOpen.info/renamed.png"));
        expect(await res.text()).toBe("OPEN-ORIGINAL");
        expect(fs.existsSync(lib)).toBe(true);
    });

    test("range requests keep working", async () => {
        const { handler } = setup();
        const res = await handler({ params: { path: "inOpen.info/d.png" }, request: new Request("http://l/x", { headers: { range: "bytes=0-3" } }) } as any);
        expect(res.status).toBe(206);
        expect(await res.text()).toBe("OPEN");
    });

    test("malformed percent-encoding is 400", async () => {
        const { handler } = setup();
        expect((await handler(ctx(undefined, req(), "%E0%A4%A"))).status).toBe(400);
    });
});
