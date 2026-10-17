import { describe, expect, test } from 'bun:test';
import { GridRequestController, type GridFetch } from '../src/lib/gridRequests';
import { ModalNavigation, type NavStatus } from '../src/lib/modalNavigation';
import type { FilterState } from '../src/stores/libraryStore';

const filters: FilterState = {
    search: '', folderId: null, includedTags: [], excludedTags: [], tagRule: 'all',
    color: null, colorAccuracy: 60, sortBy: 'modificationTime', sortOrder: 'desc',
    specialFilter: null, recursive: false,
    includedShapes: [], excludedShapes: [], customRatio: { width: 4, height: 3 }, includedTypes: [], excludedTypes: [],
};

type Item = { id: string };

interface Call {
    url: string;
    signal: AbortSignal;
    resolve: (res: Response) => void;
    reject: (err: unknown) => void;
}

const pageOf = (n: number, url: string) => new URL(url, 'http://x').searchParams.get('page') === String(n);
const body = (ids: string[], totalItems: number) =>
    new Response(JSON.stringify({ items: ids.map(id => ({ id })), totalItems }), { status: 200 });
const tick = () => new Promise(r => setTimeout(r, 0));

/** Wires nav + a real controller exactly like ImageGrid does (onChange -> observe, onSettled -> settled). */
function rig(pageSize = 2) {
    const calls: Call[] = [];
    const sel = { id: null as string | null };
    const statuses: Array<NavStatus | null> = [];
    const nav = new ModalNavigation<Item>({
        select: id => { sel.id = id; },
        onStatus: s => statuses.push(s),
    });
    const fetchFn: GridFetch = (url, init) =>
        new Promise<Response>((resolve, reject) => { calls.push({ url, signal: init.signal, resolve, reject }); });
    const make = () => {
        const ctl: GridRequestController<Item> = new GridRequestController<Item>({
            fetchFn,
            pageSize,
            onChange: () => nav.observe(sel.id, ctl),
            onSettled: () => nav.settled(sel.id, ctl),
        });
        return ctl;
    };
    return { calls, sel, statuses, nav, make };
}

async function loaded(ids: string[], total: number, pageSize = 2) {
    const r = rig(pageSize);
    const ctl = r.make();
    ctl.refresh(filters);
    r.calls[0].resolve(body(ids, total));
    await tick();
    return { ...r, ctl };
}

describe('ModalNavigation immediate moves', () => {
    test('loaded neighbours move without any request', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 4);
        sel.id = '1';
        expect(nav.navigate('next', sel.id, ctl)).toBe('moved');
        expect(sel.id).toBe('2');
        expect(nav.navigate('previous', sel.id, ctl)).toBe('moved');
        expect(sel.id).toBe('1');
        expect(calls).toHaveLength(1);
        expect(nav.intent).toBeNull();
    });

    test('exhausted last item wraps to first immediately; first wraps to last', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 2);
        expect(ctl.state.hasMore).toBe(false);
        sel.id = '2';
        expect(nav.navigate('next', sel.id, ctl)).toBe('moved');
        expect(sel.id).toBe('1');
        expect(nav.navigate('previous', sel.id, ctl)).toBe('moved');
        expect(sel.id).toBe('2');
        expect(calls).toHaveLength(1);
    });

    test('a single exhausted item does nothing', async () => {
        const { ctl, nav, sel } = await loaded(['1'], 1);
        sel.id = '1';
        expect(nav.navigate('next', sel.id, ctl)).toBe('none');
        expect(nav.navigate('previous', sel.id, ctl)).toBe('none');
        expect(sel.id).toBe('1');
    });
});

describe('ModalNavigation tail-next', () => {
    test('loads the next page and advances to exactly the first new item', async () => {
        const { ctl, nav, sel, calls, statuses } = await loaded(['1', '2'], 4);
        sel.id = '2';
        expect(nav.navigate('next', sel.id, ctl)).toBe('pending');
        expect(sel.id).toBe('2'); // stays on the current item meanwhile
        expect(calls).toHaveLength(2);
        expect(pageOf(2, calls[1].url)).toBe(true);
        expect(statuses.at(-1)).toEqual({ direction: 'next', phase: 'loading', message: null });

        calls[1].resolve(body(['3', '4'], 4));
        await tick();
        expect(sel.id).toBe('3');
        expect(nav.intent).toBeNull();
        expect(statuses.at(-1)).toBeNull();
        expect(calls).toHaveLength(2); // exhausted by total: no extra request
    });

    test('joins a page request already in flight (no duplicate fetch)', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 4);
        sel.id = '2';
        ctl.loadMore(); // e.g. infinite scroll
        expect(calls).toHaveLength(2);
        expect(nav.navigate('next', sel.id, ctl)).toBe('pending');
        expect(calls).toHaveLength(2);

        calls[1].resolve(body(['3', '4'], 4));
        await tick();
        expect(sel.id).toBe('3');
        expect(calls).toHaveLength(2);
    });

    test('empty terminal page (stale total) resolves next to the first item', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 99);
        sel.id = '2';
        nav.navigate('next', sel.id, ctl);
        calls[1].resolve(body([], 99));
        await tick();
        expect(sel.id).toBe('1');
        expect(nav.intent).toBeNull();
    });

    test('short terminal page advances to its first item', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 99);
        sel.id = '2';
        nav.navigate('next', sel.id, ctl);
        calls[1].resolve(body(['3'], 99));
        await tick();
        expect(sel.id).toBe('3');
    });
});

describe('ModalNavigation previous wrap', () => {
    test('first-prev pages sequentially (one request in flight) and lands on the true last item', async () => {
        const { ctl, nav, sel, calls, statuses } = await loaded(['1', '2'], 6);
        sel.id = '1';
        expect(nav.navigate('previous', sel.id, ctl)).toBe('pending');
        expect(statuses.at(-1)).toEqual({ direction: 'previous-wrap', phase: 'loading', message: null });
        expect(calls).toHaveLength(2);
        expect(pageOf(2, calls[1].url)).toBe(true);

        // Page 2 settles: continuation must start page 3 only now, never in parallel
        calls[1].resolve(body(['3', '4'], 6));
        await tick();
        expect(sel.id).toBe('1');
        expect(calls).toHaveLength(3);
        expect(pageOf(3, calls[2].url)).toBe(true);
        expect(calls[1].signal.aborted).toBe(false);

        calls[2].resolve(body(['5', '6'], 6));
        await tick();
        expect(sel.id).toBe('6');
        expect(nav.intent).toBeNull();
        expect(calls).toHaveLength(3); // total reached: no trailing request
        expect(statuses.at(-1)).toBeNull();
    });

    test('unknown total: paging ends at the empty terminal page, then selects the last loaded item', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 99);
        sel.id = '1';
        nav.navigate('previous', sel.id, ctl);
        calls[1].resolve(body(['3', '4'], 99));
        await tick();
        expect(calls).toHaveLength(3);
        calls[2].resolve(body([], 99));
        await tick();
        expect(sel.id).toBe('4');
        expect(calls).toHaveLength(3);
    });

    test('repeated navigation is ignored while an intent is pending', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 6);
        sel.id = '1';
        nav.navigate('previous', sel.id, ctl);
        expect(nav.navigate('previous', sel.id, ctl)).toBe('ignored');
        expect(nav.navigate('next', sel.id, ctl)).toBe('ignored');
        expect(calls).toHaveLength(2);
        expect(sel.id).toBe('1');
    });
});

describe('ModalNavigation failure and cancellation', () => {
    test('failure stays on the item, stops auto-paging, retry keeps the intent', async () => {
        const { ctl, nav, sel, calls, statuses } = await loaded(['1', '2'], 6);
        sel.id = '1';
        nav.navigate('previous', sel.id, ctl);
        calls[1].reject(new TypeError('Failed to fetch'));
        await tick();

        expect(sel.id).toBe('1');
        expect(calls).toHaveLength(2); // no auto retry
        expect(statuses.at(-1)).toEqual({ direction: 'previous-wrap', phase: 'error', message: 'Network error while loading items' });
        expect(nav.intent).not.toBeNull();
        expect(nav.navigate('next', sel.id, ctl)).toBe('ignored');

        expect(nav.retry(ctl)).toBe(true);
        expect(calls).toHaveLength(3);
        expect(pageOf(2, calls[2].url)).toBe(true);
        expect(statuses.at(-1)?.phase).toBe('loading');

        calls[2].resolve(body(['3', '4'], 6));
        await tick();
        calls[3].resolve(body(['5', '6'], 6));
        await tick();
        expect(sel.id).toBe('6');
        expect(nav.intent).toBeNull();
    });

    test('explicit cancel after an error drops the intent; later loads cannot navigate', async () => {
        const { ctl, nav, sel, calls, statuses } = await loaded(['1', '2'], 6);
        sel.id = '2';
        nav.navigate('next', sel.id, ctl);
        calls[1].resolve(new Response('{}', { status: 500 }));
        await tick();
        expect(statuses.at(-1)?.phase).toBe('error');

        nav.cancel();
        expect(nav.intent).toBeNull();
        expect(statuses.at(-1)).toBeNull();
        expect(nav.retry(ctl)).toBe(false);

        ctl.retry(); // plain grid retry (e.g. the grid's own button)
        calls[2].resolve(body(['3', '4'], 6));
        await tick();
        expect(sel.id).toBe('2');
    });

    test('closing the modal mid-intent cancels it; a late response cannot navigate', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 6);
        sel.id = '2';
        nav.navigate('next', sel.id, ctl);
        sel.id = null; // modal closed
        nav.observe(sel.id, ctl);
        expect(nav.intent).toBeNull();

        calls[1].resolve(body(['3', '4'], 6));
        await tick();
        expect(sel.id).toBeNull();
    });

    test('selecting another item mid-intent cancels it', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 6);
        sel.id = '2';
        nav.navigate('next', sel.id, ctl);
        sel.id = '1';
        nav.observe(sel.id, ctl);
        expect(nav.intent).toBeNull();

        calls[1].resolve(body(['3', '4'], 6));
        await tick();
        expect(sel.id).toBe('1');
    });

    test('context change (new generation) mid-intent cancels; the old response is ignored', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 6);
        sel.id = '2';
        nav.navigate('next', sel.id, ctl);
        ctl.refresh({ ...filters, search: 'cats' }); // bumps generation, aborts page 2
        expect(nav.intent).toBeNull();
        expect(calls[1].signal.aborted).toBe(true);

        calls[1].resolve(body(['3', '4'], 6)); // late, stale
        await tick();
        expect(sel.id).toBe('2');
    });

    test('reload (rescan) mid-intent cancels it', async () => {
        const { ctl, nav, sel } = await loaded(['1', '2'], 6);
        sel.id = '1';
        nav.navigate('previous', sel.id, ctl);
        ctl.reload();
        expect(nav.intent).toBeNull();
    });

    test('controller replacement cancels even when generation numbers repeat', async () => {
        const r = await loaded(['1', '2'], 6);
        r.sel.id = '2';
        r.nav.navigate('next', r.sel.id, r.ctl);
        const oldGeneration = r.nav.intent!.generation;

        const ctl2 = r.make();
        ctl2.refresh(filters); // generation 1 again, same as the first instance
        expect(ctl2.state.generation).toBe(oldGeneration);
        r.ctl.dispose();
        expect(r.nav.intent).toBeNull(); // ctl2's own onChange observed with a different identity

        r.calls[1].resolve(body(['3', '4'], 6)); // disposed controller's late page
        await tick();
        expect(r.sel.id).toBe('2');
    });

    test('unmount-style cancel() before a late response keeps the selection', async () => {
        const { ctl, nav, sel, calls } = await loaded(['1', '2'], 6);
        sel.id = '1';
        nav.navigate('previous', sel.id, ctl);
        nav.cancel();
        ctl.dispose();
        calls[1].resolve(body(['3', '4'], 6));
        await tick();
        expect(sel.id).toBe('1');
        expect(calls).toHaveLength(2);
    });
});
