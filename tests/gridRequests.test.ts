import { describe, expect, test } from 'bun:test';
import {
    GridRequestController,
    buildItemsUrl,
    facetContextKeys,
    hasMoreAfterPage,
    parseItemsPayload,
    resolveSelection,
    type GridErrorKind,
    type GridFetch,
    type GridState,
} from '../src/lib/gridRequests';
import type { FilterState } from '../src/stores/libraryStore';

const baseFilters: FilterState = {
    search: '', folderId: null, includedTags: [], excludedTags: [], tagRule: 'all',
    color: null, colorAccuracy: 60, sortBy: 'modificationTime', sortOrder: 'desc',
    specialFilter: null, recursive: false,
    includedShapes: [], excludedShapes: [], customRatio: { width: 4, height: 3 }, includedTypes: [], excludedTypes: [],
};
const f = (over: Partial<FilterState> = {}): FilterState => ({ ...baseFilters, ...over });

interface Call {
    url: string;
    signal: AbortSignal;
    resolve: (res: Response) => void;
    reject: (err: unknown) => void;
}

function harness(pageSize = 2) {
    const calls: Call[] = [];
    const states: GridState<{ id: string }>[] = [];
    const tags: Array<[string[], Record<string, number> | null]> = [];
    const fetchFn: GridFetch = (url, init) =>
        new Promise<Response>((resolve, reject) => {
            calls.push({ url, signal: init.signal, resolve, reject });
        });
    const ctl = new GridRequestController<{ id: string }>({
        fetchFn,
        pageSize,
        onChange: s => states.push(s),
        onContextTags: (t, c) => tags.push([t, c]),
    });
    return { calls, states, tags, ctl };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const page = (ids: string[], extra: Record<string, unknown> = {}) =>
    ok({ items: ids.map(id => ({ id })), totalItems: 99, ...extra });
const tick = () => new Promise(r => setTimeout(r, 0));
const ids = (c: { state: GridState<{ id: string }> }) => c.state.items.map(i => i.id);

describe('GridRequestController ownership', () => {
    test('newer generation wins even when the older response resolves last', async () => {
        const { calls, ctl, tags } = harness();
        ctl.refresh(f({ search: 'old' }));
        ctl.refresh(f({ search: 'new' }));
        expect(calls).toHaveLength(2);

        calls[1].resolve(page(['n1', 'n2'], { relevantTags: ['new-tag'], relevantTagCounts: { 'new-tag': 2 } }));
        await tick();
        calls[0].resolve(page(['o1', 'o2'], { relevantTags: ['old-tag'] }));
        await tick();

        expect(ids(ctl)).toEqual(['n1', 'n2']);
        expect(tags).toEqual([[['new-tag'], { 'new-tag': 2 }]]);
        expect(ctl.state.loading).toBe(false);
    });

    test('stale response cannot set items, tags, loading or hasMore', async () => {
        const { calls, ctl, tags } = harness();
        ctl.refresh(f({ search: 'old' }));
        ctl.refresh(f({ search: 'new' })); // still in flight
        calls[0].resolve(page([], { relevantTags: ['stale'] })); // short page would set hasMore=false
        await tick();

        expect(ctl.state.items).toEqual([]);
        expect(ctl.state.loading).toBe(true); // owned by the new request
        expect(ctl.state.hasMore).toBe(true);
        expect(tags).toEqual([]);
    });

    test('filter change aborts the previous request and ignores its response', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f({ search: 'a' }));
        expect(calls[0].signal.aborted).toBe(false);
        ctl.refresh(f({ search: 'b' }));
        expect(calls[0].signal.aborted).toBe(true);
        expect(calls[1].signal.aborted).toBe(false);

        calls[0].resolve(page(['x1', 'x2'])); // resolves despite abort
        await tick();
        expect(ctl.state.items).toEqual([]);

        // A stale rejection (AbortError) must not surface as an error either
        const { calls: c2, ctl: ctl2 } = harness();
        ctl2.refresh(f());
        ctl2.refresh(f({ search: 'z' }));
        c2[0].reject(new DOMException('aborted', 'AbortError'));
        await tick();
        expect(ctl2.state.error).toBeNull();
    });

    test('lock/unlock context change bumps generation and refetches page 1 with filters preserved', async () => {
        const { calls, ctl } = harness();
        const filters = f({ search: 'cat', includedTags: ['a', 'b'], tagRule: 'any', specialFilter: 'trash' });
        ctl.refresh(filters);
        calls[0].resolve(page(['1', '2']));
        await tick();
        const gen = ctl.generation;

        ctl.refresh(filters); // e.g. unlockedFolders changed
        expect(ctl.generation).toBe(gen + 1);
        expect(calls).toHaveLength(2);
        expect(ctl.state.items).toEqual([]);
        expect(ctl.state.page).toBe(1);
        const u = new URL(calls[1].url, 'http://x');
        expect(u.searchParams.get('page')).toBe('1');
        expect(u.searchParams.get('search')).toBe('cat');
        expect(u.searchParams.get('tag')).toBe('a,b');
        expect(u.searchParams.get('tagRule')).toBe('any');
        expect(u.searchParams.get('specialFilter')).toBe('trash');
    });

    test('lock/unlock during a fetch: in-flight response from before the change is dropped', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        ctl.refresh(f()); // unlock happened mid-flight
        calls[0].resolve(page(['locked-leak', 'x']));
        await tick();
        calls[1].resolve(page(['fresh']));
        await tick();
        expect(ids(ctl)).toEqual(['fresh']);
    });

    test('disabled refresh (locked view) aborts and clears without fetching', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        ctl.refresh(f({ folderId: 'L' }), false);
        expect(calls).toHaveLength(1);
        expect(calls[0].signal.aborted).toBe(true);
        calls[0].resolve(page(['a', 'b']));
        await tick();
        expect(ctl.state.items).toEqual([]);
        ctl.loadMore();
        expect(calls).toHaveLength(1);
    });
});

describe('GridRequestController pagination', () => {
    async function withPage1() {
        const h = harness();
        h.ctl.refresh(f());
        h.calls[0].resolve(page(['1', '2']));
        await tick();
        return h;
    }

    test('duplicate page requests while in flight collapse to one fetch', async () => {
        const { calls, ctl } = await withPage1();
        ctl.loadMore();
        ctl.loadMore();
        ctl.loadMore();
        expect(calls).toHaveLength(2);
        expect(new URL(calls[1].url, 'http://x').searchParams.get('page')).toBe('2');
    });

    test('page advances only after success and appends', async () => {
        const { calls, ctl } = await withPage1();
        expect(ctl.state.page).toBe(2);
        ctl.loadMore();
        expect(ctl.state.page).toBe(2);
        calls[1].resolve(page(['3', '4']));
        await tick();
        expect(ctl.state.page).toBe(3);
        expect(ids(ctl)).toEqual(['1', '2', '3', '4']);
        expect(ctl.state.hasMore).toBe(true);
    });

    test('short page ends the list', async () => {
        const { calls, ctl } = await withPage1();
        ctl.loadMore();
        calls[1].resolve(page(['3']));
        await tick();
        expect(ctl.state.hasMore).toBe(false);
        ctl.loadMore();
        expect(calls).toHaveLength(2);
    });

    const failures: Array<[string, (c: Call) => void, GridErrorKind]> = [
        ['HTTP 500', c => c.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 })), 'http'],
        ['network reject', c => c.reject(new TypeError('Failed to fetch')), 'network'],
        ['malformed payload', c => c.resolve(ok({ error: 'no items' })), 'payload'],
        ['non-JSON body', c => c.resolve(new Response('<html>', { status: 200 })), 'payload'],
    ];
    for (const [name, fail, kind] of failures) {
        test(`page-2 ${name}: retryable error, items retained, page and hasMore untouched; retry appends`, async () => {
            const { calls, ctl } = await withPage1();
            ctl.loadMore();
            fail(calls[1]);
            await tick();

            expect(ctl.state.error?.kind).toBe(kind);
            expect(ctl.state.error?.page).toBe(2);
            expect(ids(ctl)).toEqual(['1', '2']);
            expect(ctl.state.hasMore).toBe(true);
            expect(ctl.state.page).toBe(2);
            expect(ctl.state.loading).toBe(false);

            // Infinite scroll must not hammer a failing endpoint
            ctl.loadMore();
            expect(calls).toHaveLength(2);

            ctl.retry();
            expect(calls).toHaveLength(3);
            expect(new URL(calls[2].url, 'http://x').searchParams.get('page')).toBe('2');
            calls[2].resolve(page(['3', '4']));
            await tick();
            expect(ids(ctl)).toEqual(['1', '2', '3', '4']);
            expect(ctl.state.error).toBeNull();
            expect(ctl.state.page).toBe(3);
        });
    }

    test('page-1 failure is retryable and does not set hasMore=false', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        calls[0].resolve(new Response('{}', { status: 503 }));
        await tick();
        expect(ctl.state.error?.status).toBe(503);
        expect(ctl.state.hasMore).toBe(true);
        expect(ctl.state.page).toBe(1);
        ctl.retry();
        calls[1].resolve(page(['a']));
        await tick();
        expect(ids(ctl)).toEqual(['a']);
        expect(ctl.state.error).toBeNull();
    });

    test('retry without an error is a no-op', async () => {
        const { calls, ctl } = await withPage1();
        ctl.retry();
        expect(calls).toHaveLength(1);
    });

    test('contextual tags only come from page 1; empty tags are valid (degraded)', async () => {
        const { calls, ctl, tags } = harness();
        ctl.refresh(f());
        calls[0].resolve(page(['1', '2'], { relevantTags: [], relevantTagCounts: {} }));
        await tick();
        ctl.loadMore();
        calls[1].resolve(page(['3', '4'], { relevantTags: ['ignored'], relevantTagCounts: { ignored: 1 } }));
        await tick();
        // [] tags and {} counts are published as-is (not clobbered to null / dropped)
        expect(tags).toEqual([[[], {}]]);
    });
});

/** Response whose body parse is deferred, to test ownership at the second await. */
function deferredBody(body: unknown) {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const res = { ok: true, status: 200, json: async () => { await gate; return body; } } as unknown as Response;
    return { res, release };
}

describe('GridRequestController lifecycle (dispose)', () => {
    test('stale generation is dropped while the JSON body is still parsing', async () => {
        const { calls, ctl, tags } = harness();
        ctl.refresh(f({ search: 'old' }));
        const d = deferredBody({ items: [{ id: 'o1' }, { id: 'o2' }], totalItems: 9, relevantTags: ['old'] });
        calls[0].resolve(d.res);
        await tick(); // old request is now awaiting json()
        ctl.refresh(f({ search: 'new' }));
        d.release();
        await tick();
        expect(ctl.state.items).toEqual([]);
        expect(ctl.state.loading).toBe(true);
        expect(tags).toEqual([]);
        calls[1].resolve(page(['n1']));
        await tick();
        expect(ids(ctl)).toEqual(['n1']);
    });

    test('dispose during fetch: aborts, rejection swallowed, no state or tag publication', async () => {
        const { calls, states, ctl, tags } = harness();
        ctl.refresh(f());
        const before = states.length;
        ctl.dispose();
        expect(calls[0].signal.aborted).toBe(true);
        calls[0].reject(new DOMException('aborted', 'AbortError'));
        await tick();
        expect(states).toHaveLength(before);
        expect(ctl.state.error).toBeNull();
        expect(tags).toEqual([]);
    });

    test('dispose during fetch: late successful resolution is a no-op', async () => {
        const { calls, states, ctl, tags } = harness();
        ctl.refresh(f());
        const before = states.length;
        ctl.dispose();
        calls[0].resolve(page(['a', 'b'], { relevantTags: ['t'] }));
        await tick();
        expect(states).toHaveLength(before);
        expect(tags).toEqual([]);
        expect(ctl.state.items).toEqual([]);
    });

    test('dispose during JSON body parsing: no error, state or tag callbacks', async () => {
        const { calls, states, ctl, tags } = harness();
        ctl.refresh(f());
        const d = deferredBody({ items: [{ id: 'a' }], totalItems: 1, relevantTags: ['t'], relevantTagCounts: { t: 1 } });
        calls[0].resolve(d.res);
        await tick();
        const before = states.length;
        ctl.dispose();
        expect(calls[0].signal.aborted).toBe(true);
        d.release();
        await tick();
        expect(states).toHaveLength(before);
        expect(tags).toEqual([]);
        expect(ctl.state.error).toBeNull();
        expect(ctl.state.items).toEqual([]);
    });

    test('dispose during a rejecting JSON body publishes no payload error', async () => {
        const { calls, states, ctl } = harness();
        ctl.refresh(f());
        let fail!: () => void;
        const gate = new Promise<void>(r => { fail = r; });
        calls[0].resolve({ ok: true, status: 200, json: async () => { await gate; throw new SyntaxError('bad'); } } as unknown as Response);
        await tick();
        const before = states.length;
        ctl.dispose();
        fail();
        await tick();
        expect(states).toHaveLength(before);
        expect(ctl.state.error).toBeNull();
    });

    test('disposed controller ignores refresh/loadMore/retry', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        ctl.dispose();
        ctl.refresh(f({ search: 'x' }));
        ctl.loadMore();
        ctl.retry();
        expect(calls).toHaveLength(1);
    });

    test('replacement instance (effect re-setup) fetches normally; departing instance cannot overwrite it', async () => {
        const old = harness();
        const next = harness();
        const shared: string[][] = [];
        old.ctl.refresh(f({ search: 'a' }));
        old.ctl.dispose(); // effect cleanup
        next.ctl.refresh(f({ search: 'a' })); // effect setup again
        expect(next.calls).toHaveLength(1);
        expect(next.calls[0].signal.aborted).toBe(false);

        next.calls[0].resolve(page(['new1', 'new2'], { relevantTags: ['new'] }));
        await tick();
        old.calls[0].resolve(page(['old1', 'old2'], { relevantTags: ['old'] }));
        await tick();

        shared.push(...next.tags.map(t => t[0]), ...old.tags.map(t => t[0]));
        expect(ids(next.ctl)).toEqual(['new1', 'new2']);
        expect(shared).toEqual([['new']]);
        expect(old.states.every(s => s.items.length === 0)).toBe(true);
    });
});

describe('payload validation', () => {
    test('rejects missing items array and non-finite totalItems', () => {
        expect(() => parseItemsPayload({ totalItems: 1 })).toThrow();
        expect(() => parseItemsPayload({ items: [] })).toThrow();
        expect(() => parseItemsPayload({ items: [], totalItems: NaN })).toThrow();
        expect(() => parseItemsPayload({ items: [], totalItems: '5' })).toThrow();
        expect(() => parseItemsPayload(null)).toThrow();
        expect(parseItemsPayload({ items: [], totalItems: 0 }).relevantTags).toBeNull();
    });

    test('malformed 200 payload becomes an error, not a crash or empty end-of-list', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        calls[0].resolve(ok({ items: 'nope', totalItems: Infinity }));
        await tick();
        expect(ctl.state.error?.kind).toBe('payload');
        expect(ctl.state.hasMore).toBe(true);
    });
});

describe('modal selection', () => {
    test('resolves by id and is cleared when the item vanishes after a context change', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        calls[0].resolve(page(['a', 'b']));
        await tick();
        expect(resolveSelection(ctl.state.items, 'b')).toBe(1);

        ctl.refresh(f({ search: 'x' }));
        calls[1].resolve(page(['c', 'd']));
        await tick();
        expect(resolveSelection(ctl.state.items, 'b')).toBeNull();
        expect(resolveSelection(ctl.state.items, null)).toBeNull();
    });
});

describe('exhaustion detection', () => {
    test('hasMoreAfterPage: short/empty pages always end; valid totals end early; invalid totals are ignored', () => {
        expect(hasMoreAfterPage(2, 2, 2, 99)).toBe(true);
        expect(hasMoreAfterPage(4, 2, 2, 4)).toBe(false); // exact multiple of the page size
        expect(hasMoreAfterPage(3, 1, 2, 99)).toBe(false); // short final page, stale-high total
        expect(hasMoreAfterPage(2, 0, 2, 99)).toBe(false); // empty terminal page, stale-high total
        expect(hasMoreAfterPage(2, 2, 2, 0)).toBe(false);
        for (const bad of [-1, 2.5, NaN, Infinity, '4', null, undefined]) {
            expect(hasMoreAfterPage(4, 2, 2, bad)).toBe(true);
        }
    });

    test('exact page-size total stops without a trailing empty request', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        calls[0].resolve(page(['1', '2'], { totalItems: 4 }));
        await tick();
        expect(ctl.state.hasMore).toBe(true);
        ctl.loadMore();
        calls[1].resolve(page(['3', '4'], { totalItems: 4 }));
        await tick();
        expect(ctl.state.hasMore).toBe(false);
        ctl.loadMore();
        expect(calls).toHaveLength(2);
    });

    test('stale-high total: an empty terminal page still ends paging', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        calls[0].resolve(page(['1', '2'], { totalItems: 50 }));
        await tick();
        ctl.loadMore();
        calls[1].resolve(page([], { totalItems: 50 }));
        await tick();
        expect(ctl.state.hasMore).toBe(false);
        expect(ids(ctl)).toEqual(['1', '2']);
    });

    test('invalid (non-integer) total falls back to short-page detection', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f());
        calls[0].resolve(page(['1', '2'], { totalItems: 2.5 }));
        await tick();
        expect(ctl.state.hasMore).toBe(true);
        ctl.loadMore();
        calls[1].resolve(page(['3'], { totalItems: 2.5 }));
        await tick();
        expect(ctl.state.hasMore).toBe(false);
    });
});

describe('onSettled continuation', () => {
    function settledHarness(onSettledAction: (ctl: GridRequestController<{ id: string }>) => void, onChange?: (s: GridState<{ id: string }>) => void) {
        const calls: Call[] = [];
        const fetchFn: GridFetch = (url, init) =>
            new Promise<Response>((resolve, reject) => { calls.push({ url, signal: init.signal, resolve, reject }); });
        let settledCount = 0;
        const ctl: GridRequestController<{ id: string }> = new GridRequestController<{ id: string }>({
            fetchFn,
            pageSize: 2,
            onChange: s => onChange?.(s),
            onSettled: () => { settledCount++; onSettledAction(ctl); },
        });
        return { calls, ctl, settled: () => settledCount };
    }

    test('loadMore() from onChange is dropped (still in flight) but works from onSettled', async () => {
        // The race: onChange fires before the in-flight slot is released.
        let continueFromChange = false;
        const a = settledHarness(() => { }, s => { if (continueFromChange && !s.loading) a.ctl.loadMore(); });
        a.ctl.refresh(f());
        continueFromChange = true;
        a.calls[0].resolve(page(['1', '2']));
        await tick();
        expect(a.calls).toHaveLength(1); // continuation from onChange was swallowed

        const h = settledHarness(c => { if (c.state.hasMore && !c.state.error) c.loadMore(); });
        h.ctl.refresh(f());
        h.calls[0].resolve(page(['1', '2']));
        await tick();
        expect(h.calls).toHaveLength(2); // continued from onSettled
        expect(new URL(h.calls[1].url, 'http://x').searchParams.get('page')).toBe('2');
    });

    test('settles after success and after failure, once per request', async () => {
        const h = settledHarness(() => { });
        h.ctl.refresh(f());
        h.calls[0].resolve(page(['1', '2']));
        await tick();
        expect(h.settled()).toBe(1);
        h.ctl.loadMore();
        h.calls[1].reject(new TypeError('Failed to fetch'));
        await tick();
        expect(h.settled()).toBe(2);
        expect(h.ctl.state.error).not.toBeNull();
    });

    test('stale-generation and disposed requests never report settled', async () => {
        const h = settledHarness(() => { });
        h.ctl.refresh(f({ search: 'a' }));
        h.ctl.refresh(f({ search: 'b' }));
        h.calls[0].resolve(page(['x1', 'x2']));
        await tick();
        expect(h.settled()).toBe(0);
        h.ctl.dispose();
        h.calls[1].resolve(page(['y1', 'y2']));
        await tick();
        expect(h.settled()).toBe(0);
    });

    test('requests continued from onSettled stay single-flight', async () => {
        const h = settledHarness(c => { c.loadMore(); c.loadMore(); });
        h.ctl.refresh(f());
        h.calls[0].resolve(page(['1', '2']));
        await tick();
        expect(h.calls).toHaveLength(2);
    });
});

describe('reload and modal selection', () => {
    test('reload starts a new generation with an empty result set, so the open item no longer resolves', async () => {
        const { calls, ctl } = harness();
        ctl.refresh(f({ search: 'x' }));
        calls[0].resolve(page(['1', '2']));
        await tick();
        expect(resolveSelection(ctl.state.items, '2')).toBe(1);

        const before = ctl.generation;
        ctl.reload();
        expect(ctl.generation).toBe(before + 1);
        expect(resolveSelection(ctl.state.items, '2')).toBeNull();
        expect(new URL(calls[1].url, 'http://x').searchParams.get('search')).toBe('x');
    });
});

describe('buildItemsUrl', () => {
    test('keeps the established query contract', () => {
        const u = new URL(buildItemsUrl(f({ excludedTags: ['x'], recursive: true, folderId: 'F', color: '#fff' }), 3), 'http://x');
        expect(u.pathname).toBe('/api/items');
        expect(u.searchParams.get('page')).toBe('3');
        expect(u.searchParams.get('limit')).toBe('50');
        expect(u.searchParams.get('recursive')).toBe('true');
        expect(u.searchParams.get('excludedTags')).toBe('x');
        expect(u.searchParams.get('folderId')).toBe('F');
        expect(u.searchParams.get('colorAccuracy')).toBe('60');
    });

    test('shape/type facets use repeated params and always send the committed custom pair', () => {
        const u = new URL(buildItemsUrl(f({
            includedShapes: ['horizontal', '4:3'], excludedShapes: ['panoramic-horizontal'],
            includedTypes: ['png', 'jpg'], excludedTypes: ['gif', ''], customRatio: { width: 21, height: 9 },
        }), 1), 'http://x');
        expect(u.searchParams.getAll('shape')).toEqual(['horizontal', '4:3']);
        expect(u.searchParams.getAll('excludedShape')).toEqual(['panoramic-horizontal']);
        expect(u.searchParams.getAll('type')).toEqual(['png', 'jpg']);
        expect(u.searchParams.getAll('excludedType')).toEqual(['gif', '']);
        expect(u.searchParams.get('ratioWidth')).toBe('21');
        expect(u.searchParams.get('ratioHeight')).toBe('9');
        const plain = new URL(buildItemsUrl(f(), 1), 'http://x').searchParams;
        expect(plain.has('shape') || plain.has('type') || plain.has('excludedShape') || plain.has('excludedType')).toBe(false);
        expect(plain.get('ratioWidth')).toBe('4');
        expect(plain.get('ratioHeight')).toBe('3');
    });
});

describe('facet payloads', () => {
    const shapeOk = { horizontal: 1, vertical: 2, square: 0, 'panoramic-horizontal': 0, 'panoramic-vertical': 0, '4:3': 1, '3:4': 0, '16:9': 0, '9:16': 0, custom: 1 };

    test('valid maps are accepted; {} is a valid empty typeCounts', () => {
        const p = parseItemsPayload<{ id: string }>({ items: [], totalItems: 0, shapeCounts: shapeOk, typeCounts: {} });
        expect(p.shapeCounts).toEqual(shapeOk);
        expect(p.typeCounts).toEqual({});
    });

    test('bad maps become unavailable (null) without failing the items payload', () => {
        const bad = (shapeCounts: unknown, typeCounts: unknown) => parseItemsPayload<{ id: string }>({ items: [], totalItems: 0, shapeCounts, typeCounts });
        expect(bad(undefined, undefined)).toMatchObject({ shapeCounts: null, typeCounts: null });
        expect(bad(null, null)).toMatchObject({ shapeCounts: null, typeCounts: null });
        expect(bad([], [1]).shapeCounts).toBeNull();
        expect(bad({ ...shapeOk, horizontal: -1 }, {}).shapeCounts).toBeNull();
        expect(bad({ ...shapeOk, horizontal: 1.5 }, {}).shapeCounts).toBeNull();
        expect(bad({ ...shapeOk, horizontal: '1' }, {}).shapeCounts).toBeNull();
        expect(bad({ ...shapeOk, horizontal: null }, {}).shapeCounts).toBeNull();
        expect(bad({ ...shapeOk, bogus: 1 }, {}).shapeCounts).toBeNull();
        const { custom, ...missing } = shapeOk;
        expect(bad(missing, {}).shapeCounts).toBeNull();
        expect(bad(shapeOk, { png: -1 }).typeCounts).toBeNull();
        expect(bad(shapeOk, { png: Infinity }).typeCounts).toBeNull();
        expect(bad(shapeOk, { png: 'x' }).typeCounts).toBeNull();
        expect(bad(shapeOk, { ['x'.repeat(33)]: 1 }).typeCounts).toBeNull();
        expect(bad(shapeOk, []).typeCounts).toBeNull();
    });

    test('a hostile __proto__ key stays an own data key and does not pollute', () => {
        const typeCounts = JSON.parse('{"__proto__": 3, "png": 1}');
        const p = parseItemsPayload<{ id: string }>({ items: [], totalItems: 0, typeCounts });
        expect(Object.getPrototypeOf(p.typeCounts)).toBe(Object.prototype);
        expect(({} as any).polluted).toBeUndefined();
        expect(Object.keys(p.typeCounts!).sort()).toEqual(['__proto__', 'png']);
    });

    test('facets publish for current-generation page 1 only', async () => {
        const calls: Call[] = [];
        const facets: unknown[] = [];
        const ctl = new GridRequestController<{ id: string }>({
            fetchFn: (url, init) => new Promise<Response>((resolve, reject) => { calls.push({ url, signal: init.signal, resolve, reject }); }),
            pageSize: 2,
            onChange: () => { },
            onFacets: u => facets.push(u),
        });
        ctl.refresh(f({ search: 'old' }));
        ctl.refresh(f({ search: 'new' }));
        calls[1].resolve(page(['n1', 'n2'], { shapeCounts: shapeOk, typeCounts: { png: 2 } }));
        await tick();
        calls[0].resolve(page(['o1', 'o2'], { shapeCounts: { ...shapeOk, horizontal: 99 }, typeCounts: { gif: 9 } })); // stale generation
        await tick();
        expect(facets).toEqual([{ shape: shapeOk, type: { png: 2 } }]);

        ctl.loadMore(); // page 2 must not publish facets
        await tick();
        calls[2].resolve(page(['n3'], { shapeCounts: { ...shapeOk, horizontal: 50 }, typeCounts: { bmp: 1 } }));
        await tick();
        expect(facets).toHaveLength(1);
    });

    test('a page-1 response without or with bad facets publishes them as unavailable', async () => {
        const calls: Call[] = [];
        const facets: unknown[] = [];
        const ctl = new GridRequestController<{ id: string }>({
            fetchFn: (url, init) => new Promise<Response>((resolve, reject) => { calls.push({ url, signal: init.signal, resolve, reject }); }),
            onChange: () => { },
            onFacets: u => facets.push(u),
        });
        ctl.refresh(f());
        calls[0].resolve(page(['a'], { shapeCounts: { horizontal: -4 } }));
        await tick();
        expect(facets).toEqual([{ shape: null, type: null }]);
    });

    test('disabled refresh resets both facets to unavailable and publishes nothing from stale requests', async () => {
        const calls: Call[] = [];
        const facets: unknown[] = [];
        const ctl = new GridRequestController<{ id: string }>({
            fetchFn: (url, init) => new Promise<Response>((resolve, reject) => { calls.push({ url, signal: init.signal, resolve, reject }); }),
            onChange: () => { },
            onFacets: u => facets.push(u),
        });
        ctl.refresh(f());
        ctl.refresh(f({ folderId: 'L' }), false);
        expect(facets).toEqual([{ shape: null, type: null }]);
        calls[0].resolve(page(['a'], { shapeCounts: shapeOk, typeCounts: { png: 1 } }));
        await tick();
        expect(facets).toHaveLength(1);
    });
});

describe('facetContextKeys', () => {
    test('shape key ignores the shape selection but not type/other filters or the custom pair', () => {
        const a = facetContextKeys(f());
        expect(facetContextKeys(f({ includedShapes: ['square'] })).shape).toBe(a.shape);
        expect(facetContextKeys(f({ excludedShapes: ['square'] })).shape).toBe(a.shape);
        expect(facetContextKeys(f({ sortBy: 'name' })).shape).toBe(a.shape);
        expect(facetContextKeys(f({ includedTypes: ['png'] })).shape).not.toBe(a.shape);
        expect(facetContextKeys(f({ search: 'x' })).shape).not.toBe(a.shape);
        expect(facetContextKeys(f({ customRatio: { width: 1, height: 1 } })).shape).not.toBe(a.shape);
        expect(facetContextKeys(f(), 'unlocked').shape).not.toBe(a.shape);
    });

    test('type key ignores the type selection but not shape/other filters', () => {
        const a = facetContextKeys(f());
        expect(facetContextKeys(f({ includedTypes: ['png'] })).type).toBe(a.type);
        expect(facetContextKeys(f({ excludedTypes: ['png'] })).type).toBe(a.type);
        expect(facetContextKeys(f({ includedShapes: ['square'] })).type).not.toBe(a.type);
        expect(facetContextKeys(f({ folderId: 'F' })).type).not.toBe(a.type);
    });
});
