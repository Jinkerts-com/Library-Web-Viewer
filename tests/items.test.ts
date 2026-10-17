import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from '../src/lib/schema';
import type { FolderNode, LockState } from '../src/lib/itemAccess';
import { createItemsHandler, GENERIC_ERROR_MESSAGE, type ItemsHandlerDeps } from '../src/lib/itemsHandler';
import { normalizePalettes, normalizeStringArray, serializeItem } from '../src/lib/itemSerialization';
import { computeOffset, parseColorAccuracy, parseLimit, parsePage } from '../src/lib/requestParams';
import { unlockCookie } from '../src/lib/unlock';

const folderTree: FolderNode[] = [
    { id: "open", children: [{ id: "openChild", children: [] }] },
    { id: "secret", children: [] }
];

const opened: Database[] = [];
afterEach(() => { while (opened.length) opened.pop()!.close(); });

function setup(opts: { locked?: string[]; logs?: any[][]; db?: ItemsHandlerDeps['db'] } = {}) {
    const db = new Database(":memory:");
    opened.push(db);
    ensureSchema(db);
    const state: LockState = { ready: true, folders: folderTree, lockedFolderIds: new Set(opts.locked ?? []) };
    const logs = opts.logs ?? [];
    const handler = createItemsHandler({
        db: opts.db ?? db,
        ensureLockState: async () => { },
        getLockState: () => state,
        subtreeFolderIds: (id) => id === "open" ? ["open", "openChild"] : id === "secret" ? ["secret"] : null,
        log: { error: (...a: any[]) => { logs.push(a); } }
    });
    const insert = (id: string, c: Record<string, unknown> = {}) => {
        const row: Record<string, unknown> = {
            id, name: id, ext: "png", size: 1, modificationTime: 1000, btime: 1000, width: 10, height: 10,
            tags: "[]", folders: "[]", description: "", palettes: "[]", star: 0, duration: null, isDeleted: 0, last_scanned: 1, ...c
        };
        const keys = Object.keys(row);
        db.query(`INSERT INTO items (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => row[k] as any));
    };
    const get = async (query = "", cookieIds: string[] = []) => {
        const cookie = cookieIds.map(i => unlockCookie(i).split(';')[0]).join('; ');
        const res = await handler({ request: new Request(`http://localhost/api/items?${query}`, cookie ? { headers: { cookie } } : {}) } as any) as Response;
        return { res, body: await res.json() as any };
    };
    return { db, insert, get, logs };
}

describe("requestParams", () => {
    test("limit: default, cap at 200, invalid -> default", () => {
        expect(parseLimit(null)).toBe(50);
        expect(parseLimit("1000000")).toBe(200);
        expect(parseLimit("1e6")).toBe(200);
        expect(parseLimit("1e999")).toBe(200);
        expect(parseLimit("200")).toBe(200);
        expect(parseLimit("25")).toBe(25);
        for (const bad of ["0", "-5", "NaN", "abc", "1.5", "", "0x10", " "]) expect(parseLimit(bad)).toBe(50);
    });

    test("page: clamped/default and offset is always safe", () => {
        expect(parsePage(null)).toBe(1);
        for (const bad of ["0", "-3", "NaN", "x", "2.5"]) expect(parsePage(bad)).toBe(1);
        expect(parsePage("3")).toBe(3);
        const huge = parsePage("99999999999999999999999");
        expect(huge).toBe(1_000_000);
        expect(computeOffset(huge, 200)).toBe(199_999_800);
        expect(computeOffset(Number.MAX_SAFE_INTEGER, 200)).toBeNull();
        expect(computeOffset(-1, 50)).toBeNull();
    });

    test("colorAccuracy: zero preserved, clamped 0-150, garbage -> 60", () => {
        expect(parseColorAccuracy("0")).toBe(0);
        expect(parseColorAccuracy("60")).toBe(60);
        expect(parseColorAccuracy("150")).toBe(150);
        expect(parseColorAccuracy("151")).toBe(150);
        expect(parseColorAccuracy("99999")).toBe(150);
        expect(parseColorAccuracy("-5")).toBe(0);
        expect(parseColorAccuracy("12.9")).toBe(12);
        for (const bad of [null, "", "abc", "NaN"]) expect(parseColorAccuracy(bad)).toBe(60);
    });
});

describe("row normalization", () => {
    test("tags/folders always become string arrays, independently", () => {
        for (const raw of [null, undefined, "", "not json", "{\"a\":1}", "5", "\"str\"", "null", "[1, null, {}, \"ok\", [\"n\"]]"]) {
            expect(Array.isArray(normalizeStringArray(raw))).toBe(true);
            expect(normalizeStringArray(raw).every(v => typeof v === "string")).toBe(true);
        }
        expect(normalizeStringArray("[1, \"ok\", null]")).toEqual(["ok"]);
        expect(normalizeStringArray("\"abc\"")).toEqual([]);
        const item = serializeItem({ id: "a", name: "a", ext: "png", tags: "garbage", folders: '["f1"]', palettes: null });
        expect(item.tags).toEqual([]);
        expect(item.folders).toEqual(["f1"]);
        expect(item.palettes).toEqual([]);
        expect(serializeItem({ id: "b" }).tags).toEqual([]);
    });

    test("palettes: valid entries kept, malformed dropped", () => {
        const raw = JSON.stringify([
            { color: [1, 2, 3], ratio: 10 },
            { color: [1, 2], ratio: 10 },
            { color: "red", ratio: 1 },
            { color: [1, 2, "3"], ratio: 1 },
            { color: [1, 2, 3] },
            "str", null, 7,
            { color: [4, 5, 6], ratio: 2.5 }
        ]);
        expect(normalizePalettes(raw)).toEqual([{ color: [1, 2, 3], ratio: 10 }, { color: [4, 5, 6], ratio: 2.5 }]);
        expect(normalizePalettes("{\"color\":[1,2,3],\"ratio\":1}")).toEqual([]);
        expect(normalizePalettes("oops")).toEqual([]);
    });
});

describe("/api/items handler", () => {
    test("limit is capped at 200 and malformed values use the default", async () => {
        const t = setup();
        for (let i = 0; i < 260; i++) t.insert(`i${String(i).padStart(3, "0")}`, { modificationTime: i });
        expect((await t.get("limit=1000000")).body.items).toHaveLength(200);
        expect((await t.get("limit=999999")).body.totalItems).toBe(260);
        for (const bad of ["0", "-1", "NaN", "1.5", "abc"]) expect((await t.get(`limit=${bad}`)).body.items).toHaveLength(50);
        expect((await t.get()).body.items).toHaveLength(50);
    });

    test("malformed / huge page never crashes", async () => {
        const t = setup();
        t.insert("a");
        for (const p of ["0", "-1", "NaN", "abc", "1.5"]) {
            const { res, body } = await t.get(`page=${p}`);
            expect(res.status).toBe(200);
            expect(body.items).toHaveLength(1);
        }
        const { res, body } = await t.get("page=999999999999999999999999&limit=1000000");
        expect(res.status).toBe(200);
        expect(body.items).toEqual([]);
    });

    test("golden: valid rows serialize as before and keep the response shape", async () => {
        const t = setup();
        t.insert("g1", {
            name: "Golden", tags: '["a","b"]', folders: '["open"]', description: "d", star: 3, duration: 1.5,
            palettes: '[{"color":[10,20,30],"ratio":55.5}]'
        });
        const { body } = await t.get();
        expect(Object.keys(body).sort()).toEqual(["items", "relevantTagCounts", "relevantTags", "totalItems"]);
        expect(body.totalItems).toBe(1);
        expect(body.relevantTags).toEqual(["a", "b"]);
        expect(body.relevantTagCounts).toEqual({ a: 1, b: 1 });
        expect(body.items[0]).toEqual({
            id: "g1", name: "Golden", ext: "png", size: 1, modificationTime: 1000, btime: 1000, width: 10, height: 10,
            tags: ["a", "b"], folders: ["open"], description: "d", palettes: [{ color: [10, 20, 30], ratio: 55.5 }],
            star: 3, duration: 1.5, isDeleted: 0, last_scanned: 1
        });
    });

    test("corrupt tags/folders/palettes rows serialize to conforming arrays (no locks)", async () => {
        const t = setup();
        t.insert("bad", { tags: "{oops", folders: '"str"', palettes: "[[[" });
        t.insert("types", { tags: '[1,"x",null]', folders: '{"a":1}', palettes: '{"x":1}' });
        const { body } = await t.get();
        expect(body.totalItems).toBe(2);
        for (const it of body.items) {
            expect(Array.isArray(it.tags)).toBe(true);
            expect(Array.isArray(it.folders)).toBe(true);
            expect(Array.isArray(it.palettes)).toBe(true);
        }
        expect(body.items.find((i: any) => i.id === "types").tags).toEqual(["x"]);
        expect(body.relevantTags).toEqual(["x"]);
    });

    test("fail closed: corrupt folders + active locks -> excluded from list, count and contextual tags", async () => {
        const t = setup({ locked: ["secret"] });
        t.insert("ok", { folders: '["open"]', tags: '["visible"]' });
        t.insert("bare", { folders: "[]", tags: '["bare"]' });
        t.insert("nullf", { folders: null, tags: '["nullf"]' });
        t.insert("secretItem", { folders: '["secret"]', tags: '["leak"]' });
        t.insert("corrupt", { folders: "{broken", tags: '["leakCorrupt"]' });
        t.insert("wrongType", { folders: '"secret"', tags: '["leakWrong"]' });
        t.insert("nonStringEl", { folders: '[5, "open"]', tags: '["leakEl"]' });
        for (const q of ["", "recursive=true&folderId=open", "specialFilter=uncategorized", "search=leak"]) {
            const { body } = await t.get(q);
            const ids = body.items.map((i: any) => i.id);
            for (const hidden of ["corrupt", "wrongType", "nonStringEl", "secretItem"]) expect(ids).not.toContain(hidden);
            expect(body.totalItems).toBe(body.items.length);
        }
        const all = await t.get();
        expect(all.body.items.map((i: any) => i.id).sort()).toEqual(["bare", "nullf", "ok"]);
        expect(all.body.totalItems).toBe(3);
        expect(all.body.relevantTags).toEqual(["bare", "nullf", "visible"]);
        // Trash and tag filters cannot reveal them either
        t.insert("trashedCorrupt", { folders: "{broken", isDeleted: 1, tags: '["leakT"]' });
        const trash = await t.get("specialFilter=trash");
        expect(trash.body.items).toEqual([]);
        expect(trash.body.relevantTags).toEqual([]);
        expect((await t.get("tag=leakCorrupt")).body.totalItems).toBe(0);
    });

    test("corrupt folders without locks degrade to folderless", async () => {
        const t = setup();
        t.insert("corrupt", { folders: "{broken", tags: '["t"]' });
        t.insert("ok", { folders: '["open"]' });
        const all = await t.get();
        expect(all.body.totalItems).toBe(2);
        expect(all.body.items.find((i: any) => i.id === "corrupt").folders).toEqual([]);
        expect((await t.get("specialFilter=uncategorized")).body.items.map((i: any) => i.id)).toEqual(["corrupt"]);
        expect((await t.get("folderId=open")).body.items.map((i: any) => i.id)).toEqual(["ok"]);
    });

    test("unlocking all locks (cookie) ends fail-closed exclusion for that client", async () => {
        const t = setup({ locked: ["secret"] });
        t.insert("corrupt", { folders: "{broken" });
        expect((await t.get()).body.totalItems).toBe(0);
        expect((await t.get("", ["secret"])).body.totalItems).toBe(1);
    });

    test("corrupt tags JSON does not crash tag/exclusion/search/untagged/contextual queries", async () => {
        const t = setup();
        t.insert("corrupt", { tags: "{{nope", name: "needle" });
        t.insert("numeric", { tags: '[1,2]' });
        t.insert("good", { tags: '["a"]' });
        for (const q of ["tag=a", "tag=a,b&tagRule=any", "excludedTags=a", "search=needle", "specialFilter=untagged", "tag=1"]) {
            const { res } = await t.get(q);
            expect(res.status).toBe(200);
        }
        expect((await t.get("tag=a")).body.items.map((i: any) => i.id)).toEqual(["good"]);
        expect((await t.get("excludedTags=a")).body.totalItems).toBe(2);
        expect((await t.get("search=needle")).body.items.map((i: any) => i.id)).toEqual(["corrupt"]);
        expect((await t.get("specialFilter=untagged")).body.items.map((i: any) => i.id).sort()).toEqual(["corrupt", "numeric"]);
        expect((await t.get()).body.relevantTags).toEqual(["a"]);
    });

    test("colorAccuracy: 0 is exact, inclusive; 60 behaves as before; clamping; garbage default", async () => {
        const t = setup();
        t.insert("exact", { palettes: '[{"color":[255,0,0],"ratio":1}]' });
        t.insert("near", { palettes: '[{"color":[250,5,0],"ratio":1}]' }); // distance ~7.07
        t.insert("far", { palettes: '[{"color":[0,0,255],"ratio":1}]' });
        t.insert("edge", { palettes: '[{"color":[255,60,0],"ratio":1}]' }); // distance exactly 60
        t.insert("junk", { palettes: '["x", {"color":"red"}, {"color":["a","b","c"]}, null, 5]' });
        t.insert("badjson", { palettes: "[[[" });
        const ids = async (q: string) => (await t.get(q)).body.items.map((i: any) => i.id).sort();
        expect(await ids("color=ff0000&colorAccuracy=0")).toEqual(["exact"]);
        expect(await ids("color=%23ff0000&colorAccuracy=0")).toEqual(["exact"]);
        expect(await ids("color=ff0000&colorAccuracy=60")).toEqual(["edge", "exact", "near"]);
        expect(await ids("color=ff0000")).toEqual(["edge", "exact", "near"]);
        expect(await ids("color=ff0000&colorAccuracy=abc")).toEqual(["edge", "exact", "near"]);
        expect(await ids("color=ff0000&colorAccuracy=1")).toEqual(["exact"]);
        expect(await ids("color=ff0000&colorAccuracy=999999")).toEqual(await ids("color=ff0000&colorAccuracy=150"));
        expect((await t.get("color=ff0000&colorAccuracy=0")).res.status).toBe(200);
    });

    test("color filter requires exactly three components in an array", async () => {
        const t = setup();
        t.insert("exact", { palettes: '[{"color":[255,0,0],"ratio":1}]' });
        t.insert("four", { palettes: '[{"color":[255,0,0,99],"ratio":1}]' });
        t.insert("five", { palettes: '[{"color":[255,0,0,0,0],"ratio":1}]' });
        t.insert("two", { palettes: '[{"color":[255,0],"ratio":1}]' });
        t.insert("objColor", { palettes: '[{"color":{"0":255,"1":0,"2":0},"ratio":1}]' });
        t.insert("strColor", { palettes: '[{"color":"255,0,0","ratio":1}]' });
        t.insert("boundary", { palettes: '[{"color":[255,60,0],"ratio":1}]' });
        t.insert("mixed", { palettes: '["x", 5, null, {"color":[255,0,0,1]}, {"color":[255,0,0]}]' });
        const ids = async (q: string) => (await t.get(q)).body.items.map((i: any) => i.id).sort();
        expect(await ids("color=ff0000&colorAccuracy=0")).toEqual(["exact", "mixed"]);
        expect(await ids("color=ff0000&colorAccuracy=60")).toEqual(["boundary", "exact", "mixed"]);
        expect(await ids("color=ff0000&colorAccuracy=59")).toEqual(["exact", "mixed"]);
        const four = (await t.get("color=ff0000&colorAccuracy=150")).body;
        expect(four.items.map((i: any) => i.id)).not.toContain("four");
        expect(four.totalItems).toBe(four.items.length);
    });

    test("contextual tag query failure returns empty tags, keeps items, never uses global tags", async () => {
        const logs: any[][] = [];
        const boom = new Error("SECRET contextual failure");
        let real: Database;
        const wrapper: ItemsHandlerDeps['db'] = {
            query(sql: string) {
                if (sql.includes("GROUP BY je.value")) throw boom;
                return real.query(sql) as any;
            }
        };
        const t = setup({ locked: ["secret"], logs, db: wrapper });
        real = t.db;
        t.insert("ok", { folders: '["open"]', tags: '["visible"]' });
        t.insert("wrongType", { folders: '"secret"', tags: '["leakWrong"]' });
        t.insert("nonStringEl", { folders: '[5, "open"]', tags: '["leakEl"]' });
        t.insert("braces", { folders: "{}", tags: '["leakBraces"]' });
        t.insert("secretItem", { folders: '["secret"]', tags: '["leak"]' });
        const { res, body } = await t.get();
        expect(res.status).toBe(200);
        expect(body.items.map((i: any) => i.id)).toEqual(["ok"]);
        expect(body.totalItems).toBe(1);
        expect(body.relevantTags).toEqual([]);
        expect(body.relevantTagCounts).toEqual({});
        const text = JSON.stringify(body);
        for (const leaked of ["leakWrong", "leakEl", "leakBraces", "leak\"", "fallback"]) expect(text).not.toContain(leaked);
        expect(logs.some(l => l[1] === boom)).toBe(true);
    });

    test("internal errors return a generic message and log the details", async () => {
        const logs: any[][] = [];
        const boom = new Error("SECRET: C:\\very\\private\\path SQL near x");
        const t = setup({
            logs,
            db: { query() { throw boom; } }
        });
        const { res, body } = await t.get();
        expect(res.status).toBe(500);
        expect(body).toEqual({ error: GENERIC_ERROR_MESSAGE });
        expect(JSON.stringify(body)).not.toContain("SECRET");
        expect(logs.length).toBeGreaterThan(0);
        expect(logs[0][1]).toBe(boom);
    });

    test("a throwing logger cannot change the error response", async () => {
        const t = setup({ db: { query() { throw new Error("x"); } } });
        const handler = createItemsHandler({
            db: { query() { throw new Error("x"); } },
            ensureLockState: async () => { },
            getLockState: () => ({ ready: true, folders: [], lockedFolderIds: new Set() }),
            subtreeFolderIds: () => null,
            log: { error() { throw new Error("logger down"); } }
        });
        const res = await handler({ request: new Request("http://localhost/api/items") } as any) as Response;
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: GENERIC_ERROR_MESSAGE });
        void t;
    });

    test("not-ready lock metadata still fails closed with 503", async () => {
        const t = setup();
        const handler = createItemsHandler({
            db: t.db, ensureLockState: async () => { },
            getLockState: () => ({ ready: false, folders: [], lockedFolderIds: new Set() }),
            subtreeFolderIds: () => null
        });
        const res = await handler({ request: new Request("http://localhost/api/items") } as any) as Response;
        expect(res.status).toBe(503);
    });

    test("pagination is stable across pages for tied sort values; random still varies", async () => {
        const t = setup();
        for (let i = 0; i < 25; i++) t.insert(`t${String(i).padStart(2, "0")}`, { modificationTime: 5, star: 1, size: 7 });
        for (const sort of ["modificationTime", "star", "size", "name", "ext", "dimensions", "duration", "btime"]) {
            for (const order of ["asc", "desc"]) {
                const seen: string[] = [];
                for (let page = 1; page <= 3; page++) {
                    seen.push(...(await t.get(`sortBy=${sort}&sortOrder=${order}&limit=10&page=${page}`)).body.items.map((i: any) => i.id));
                }
                expect(seen).toHaveLength(25);
                expect(new Set(seen).size).toBe(25);
            }
        }
        const orders = new Set<string>();
        for (let i = 0; i < 6; i++) {
            orders.add((await t.get("specialFilter=random&limit=25")).body.items.map((x: any) => x.id).join());
        }
        expect(orders.size).toBeGreaterThan(1);
    });

    test("trash isolation, flat/recursive folders and tag rules are unchanged", async () => {
        const t = setup();
        t.insert("a", { folders: '["open"]', tags: '["x","y"]' });
        t.insert("b", { folders: '["openChild"]', tags: '["x"]' });
        t.insert("c", { folders: '["open"]', tags: '["y"]', isDeleted: 1 });
        const ids = async (q: string) => (await t.get(q)).body.items.map((i: any) => i.id).sort();
        expect(await ids("folderId=open")).toEqual(["a"]);
        expect(await ids("folderId=open&recursive=true")).toEqual(["a", "b"]);
        expect(await ids("folderId=missing&recursive=true")).toEqual([]);
        expect(await ids("specialFilter=trash")).toEqual(["c"]);
        expect(await ids("tag=x,y")).toEqual(["a"]);
        expect(await ids("tag=x,y&tagRule=any")).toEqual(["a", "b"]);
        expect(await ids("excludedTags=y")).toEqual(["b"]);
    });
});
