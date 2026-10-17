import { describe, expect, test } from 'bun:test';
import {
    ScanClient,
    parseRetryAfter,
    parseScanStatus,
    type EventSourceLike,
    type ScanStatusMessage,
    type ScanUiState,
} from '../src/lib/scanClient';
import { GridRequestController, type GridFetch } from '../src/lib/gridRequests';
import type { FilterState } from '../src/stores/libraryStore';

const idleMsg = (over: Partial<ScanStatusMessage> = {}): ScanStatusMessage => ({
    isScanning: false, scannedCount: 0, totalItems: null, outcome: null, error: null, failedItems: 0, finishedAt: null, ...over,
});
const runningMsg = (n = 1): ScanStatusMessage => idleMsg({ isScanning: true, scannedCount: n });
const doneMsg = (outcome: 'success' | 'partial' | 'failure', finishedAt: number, over: Partial<ScanStatusMessage> = {}) =>
    idleMsg({ outcome, finishedAt, ...over });

class FakeES implements EventSourceLike {
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    closed = false;
    close() { this.closed = true; }
    open() { this.onopen?.({}); }
    send(m: ScanStatusMessage) { this.onmessage?.({ data: JSON.stringify(m) }); }
    fail() { this.onerror?.({}); }
}

type Spec = { status: number; body?: unknown; headers?: Record<string, string> };
type Reply = Spec | 'throw' | 'hang' | 'hangBody' | { wait: Promise<Spec> };

/** A reply that resolves only when `release` is called (a delayed response). */
function deferred(): { reply: Reply; release: (spec: Spec) => void } {
    let release!: (spec: Spec) => void;
    const wait = new Promise<Spec>(r => { release = r; });
    return { reply: { wait }, release };
}

function harness(opts: { noEventSource?: boolean; maxPollFailures?: number; maxPollMs?: number; requestTimeoutMs?: number } = {}) {
    let clock = 0;
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
    const calls: Array<{ url: string; method?: string }> = [];
    const replies: Record<string, Reply[]> = { '/api/scan': [], '/api/status': [] };
    const sources: FakeES[] = [];
    const states: ScanUiState[] = [];
    let completions = 0;

    const signals: Array<AbortSignal | undefined> = [];
    const fetchFn = async (url: string, init?: { method?: string; signal?: AbortSignal }) => {
        calls.push({ url, method: init?.method });
        signals.push(init?.signal);
        const reply = replies[url]?.shift();
        if (!reply || reply === 'throw') throw new Error('network');
        // 'hang' ignores the abort signal on purpose: the client must not rely on it.
        if (reply === 'hang') return new Promise<Response>(() => { });
        if (reply === 'hangBody') return { ok: true, status: 200, json: () => new Promise(() => { }) } as unknown as Response;
        const spec = 'wait' in reply ? await reply.wait : reply;
        return new Response(spec.body === undefined ? null : JSON.stringify(spec.body), { status: spec.status, headers: spec.headers });
    };
    const client = new ScanClient({
        fetchFn,
        createEventSource: () => {
            if (opts.noEventSource) return null;
            const es = new FakeES();
            sources.push(es);
            return es;
        },
        schedule: (fn, ms) => {
            const t = { at: clock + ms, fn, cancelled: false };
            timers.push(t);
            return () => { t.cancelled = true; };
        },
        now: () => clock,
        onScanComplete: () => { completions++; },
        onChange: s => states.push(s),
        pollIntervalMs: 3000,
        cooldownMs: 10_000,
        maxPollFailures: opts.maxPollFailures ?? 3,
        maxPollMs: opts.maxPollMs,
        requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
    });
    // Macrotask turn: Response.json() resolves outside the microtask queue
    const flush = async () => { await new Promise(r => setTimeout(r, 0)); };
    const advance = async (ms: number) => {
        const target = clock + ms;
        for (;;) {
            const due = timers.filter(t => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            due.cancelled = true;
            clock = due.at;
            due.fn();
            await flush();
        }
        clock = target;
    };
    const pending = () => timers.filter(t => !t.cancelled).length;
    return {
        client, calls, replies, sources, states, signals, advance, flush, pending,
        get completions() { return completions; },
        scanPosts: () => calls.filter(c => c.url === '/api/scan').length,
        statusGets: () => calls.filter(c => c.url === '/api/status').length,
        es: () => sources[sources.length - 1],
    };
}

describe('parsing', () => {
    test('parseRetryAfter clamps and falls back', () => {
        expect(parseRetryAfter('7', 10)).toBe(7);
        expect(parseRetryAfter(null, 10)).toBe(10);
        expect(parseRetryAfter('abc', 10)).toBe(10);
        expect(parseRetryAfter('0', 10)).toBe(10);
        expect(parseRetryAfter('999999', 10)).toBe(3600);
    });
    test('parseScanStatus validates shape and accepts total/totalItems', () => {
        expect(parseScanStatus(null)).toBeNull();
        expect(parseScanStatus({ scannedCount: 1 })).toBeNull();
        expect(parseScanStatus({ isScanning: true, scannedCount: 3, total: 9 })?.totalItems).toBe(9);
        expect(parseScanStatus({ isScanning: false, outcome: 'bogus' })?.outcome).toBeNull();
    });
});

describe('start / request handling', () => {
    test('repeated clicks while requesting or running send one POST', async () => {
        const h = harness();
        h.client.attach();
        h.es().open();
        h.replies['/api/scan'].push({ status: 200, body: { status: 'accepted' } });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        const first = h.client.start();
        void h.client.start();
        void h.client.start();
        await first;
        await h.client.start();
        expect(h.scanPosts()).toBe(1);
        expect(h.calls[0].method).toBe('POST');
        expect(h.client.state.phase).toBe('running');
        expect(h.client.state.canStart).toBe(false);
    });

    test('409 busy is informational and joins the running scan', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.replies['/api/scan'].push({ status: 409, body: { status: 'busy' } });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.client.start();
        expect(h.client.state.phase).toBe('running');
        expect(h.client.state.notice?.kind).toBe('busy');
    });

    test('429 enters cooldown from Retry-After and counts down to idle', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.replies['/api/scan'].push({ status: 429, headers: { 'Retry-After': '3' } });
        await h.client.start();
        expect(h.client.state.phase).toBe('cooldown');
        expect(h.client.state.cooldownSeconds).toBe(3);
        expect(h.client.state.notice?.kind).toBe('rate_limited');
        await h.client.start();
        expect(h.scanPosts()).toBe(1);
        await h.advance(1000);
        expect(h.client.state.cooldownSeconds).toBe(2);
        await h.advance(2000);
        expect(h.client.state.phase).toBe('idle');
        expect(h.client.state.notice).toBeNull();
        expect(h.pending()).toBe(0);
    });

    test('503 surfaces the unconfigured message and stays retryable', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.replies['/api/scan'].push({ status: 503, body: { status: 'unavailable' } });
        await h.client.start();
        expect(h.client.state.notice?.kind).toBe('unconfigured');
        expect(h.client.state.notice?.message).toContain('not configured');
        expect(h.client.state.phase).toBe('idle');
    });

    test('network failure is retryable', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.replies['/api/scan'].push('throw');
        await h.client.start();
        expect(h.client.state.notice?.kind).toBe('network');
        expect(h.client.state.canStart).toBe(true);
        h.replies['/api/scan'].push({ status: 200 });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.client.start();
        expect(h.scanPosts()).toBe(2);
        expect(h.client.state.phase).toBe('running');
    });

    test('other HTTP errors are reported without cooldown', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.replies['/api/scan'].push({ status: 403 });
        await h.client.start();
        expect(h.client.state.notice?.kind).toBe('error');
        expect(h.client.state.phase).toBe('idle');
    });
});

describe('lifecycle and completion', () => {
    async function runToRunning(h: ReturnType<typeof harness>) {
        h.client.attach(); h.es().open();
        h.es().send(idleMsg({ outcome: 'success', finishedAt: 100 })); // baseline snapshot
        h.replies['/api/scan'].push({ status: 200 });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.client.start();
    }

    test('baseline snapshot is not news and does not refresh', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.es().send(idleMsg({ outcome: 'failure', finishedAt: 5, error: 'old' }));
        expect(h.client.state.notice).toBeNull();
        expect(h.completions).toBe(0);
    });

    test('success: refreshes exactly once, then cooldown, then idle', async () => {
        const h = harness();
        await runToRunning(h);
        h.es().send(runningMsg(42));
        expect(h.client.state.scannedCount).toBe(42);
        h.es().send(doneMsg('success', 200));
        h.es().send(doneMsg('success', 200)); // duplicate delivery
        expect(h.completions).toBe(1);
        expect(h.client.state.notice?.kind).toBe('success');
        expect(h.client.state.phase).toBe('cooldown');
        await h.advance(10_000);
        expect(h.client.state.phase).toBe('idle');
        expect(h.completions).toBe(1);
    });

    test('partial: warns with failed count and still refreshes once', async () => {
        const h = harness();
        await runToRunning(h);
        h.es().send(doneMsg('partial', 200, { failedItems: 4 }));
        expect(h.client.state.notice?.kind).toBe('partial');
        expect(h.client.state.notice?.failedItems).toBe(4);
        expect(h.client.state.notice?.message).toContain('4');
        expect(h.completions).toBe(1);
    });

    test('failure: error notice persists after cooldown, no refresh, retry possible', async () => {
        const h = harness();
        await runToRunning(h);
        h.es().send(doneMsg('failure', 200, { error: 'metadata.json is unreadable' }));
        expect(h.client.state.notice?.kind).toBe('failure');
        expect(h.client.state.notice?.message).toContain('unreadable');
        expect(h.completions).toBe(0);
        await h.advance(10_000);
        expect(h.client.state.phase).toBe('idle');
        expect(h.client.state.notice?.kind).toBe('failure');
        expect(h.client.state.canStart).toBe(true);
        h.client.dismissNotice();
        expect(h.client.state.notice).toBeNull();
    });

    test('terminal message arriving before the POST resolves is not lost', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.es().send(idleMsg({ outcome: 'success', finishedAt: 100 }));
        h.replies['/api/scan'].push({ status: 200 });
        const p = h.client.start();
        h.es().send(doneMsg('success', 200)); // fast scan finished before response handled
        await p;
        expect(h.completions).toBe(1);
        expect(h.client.state.phase).toBe('cooldown');
    });

    test('scan started elsewhere is followed through to completion', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.es().send(idleMsg());
        h.es().send(runningMsg(3));
        expect(h.client.state.phase).toBe('running');
        h.es().send(doneMsg('success', 50));
        expect(h.completions).toBe(1);
    });
});

describe('SSE disconnect recovery', () => {
    test('polling starts on stream error while running and stops when status reports terminal', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.es().send(idleMsg({ outcome: 'success', finishedAt: 1 }));
        h.replies['/api/scan'].push({ status: 200 });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() }); // reconcile poll
        await h.client.start();
        h.replies['/api/status'].push({ status: 200, body: runningMsg(5) });
        h.es().fail();
        await h.flush();
        expect(h.client.state.polling).toBe(true);
        h.replies['/api/status'].push({ status: 200, body: runningMsg(9) });
        await h.advance(3000);
        h.replies['/api/status'].push({ status: 200, body: doneMsg('success', 2) });
        await h.advance(3000);
        expect(h.completions).toBe(1);
        expect(h.client.state.polling).toBe(false);
        const gets = h.statusGets();
        await h.advance(60_000);
        expect(h.statusGets()).toBe(gets);
    });

    test('no polling on stream error while idle', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.es().fail();
        await h.flush();
        expect(h.statusGets()).toBe(0);
        expect(h.client.state.polling).toBe(false);
    });

    test('SSE reconnect stops polling and its snapshot completes the scan', async () => {
        const h = harness();
        h.client.attach(); h.es().open();
        h.es().send(idleMsg({ outcome: 'success', finishedAt: 1 }));
        h.replies['/api/scan'].push({ status: 200 });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.client.start();
        h.es().fail();
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.flush();
        expect(h.client.state.polling).toBe(true);
        h.es().open();
        expect(h.client.state.polling).toBe(false);
        h.es().send(doneMsg('partial', 9, { failedItems: 1 }));
        expect(h.completions).toBe(1);
    });

    test('polling is bounded by consecutive failures', async () => {
        const h = harness({ maxPollFailures: 3 });
        h.client.attach(); h.es().open();
        h.es().send(idleMsg());
        h.replies['/api/scan'].push({ status: 200 });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.client.start();
        h.es().fail();
        await h.flush();
        await h.advance(30_000);
        expect(h.client.state.polling).toBe(false);
        expect(h.client.state.phase).toBe('idle');
        expect(h.client.state.notice?.kind).toBe('disconnected');
        expect(h.pending()).toBe(0);
    });

    test('detach/dispose stops polling and closes the stream', async () => {
        const h = harness();
        const detach = h.client.attach(); h.es().open();
        h.es().send(idleMsg());
        h.replies['/api/scan'].push({ status: 200 });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.client.start();
        h.es().fail();
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.flush();
        expect(h.client.state.polling).toBe(true);
        detach();
        expect(h.es().closed).toBe(true);
        expect(h.client.state.polling).toBe(false);
        const gets = h.statusGets();
        await h.advance(60_000);
        expect(h.statusGets()).toBe(gets);
        h.client.dispose();
    });

    test('without EventSource support, polling drives a started scan to completion', async () => {
        const h = harness({ noEventSource: true });
        h.client.attach();
        h.replies['/api/scan'].push({ status: 200 });
        h.replies['/api/status'].push({ status: 200, body: idleMsg({ outcome: 'success', finishedAt: 1 }) });
        h.replies['/api/status'].push({ status: 200, body: runningMsg() });
        await h.client.start();
        await h.flush();
        h.replies['/api/status'].push({ status: 200, body: runningMsg(2) });
        await h.advance(3000);
        h.replies['/api/status'].push({ status: 200, body: doneMsg('success', 7) });
        await h.advance(3000);
        expect(h.completions).toBe(1);
        expect(h.client.state.polling).toBe(false);
    });
});

/** Attach, open the stream, baseline, and start a scan whose reconcile GET gets `statusReply`. */
async function startWith(h: ReturnType<typeof harness>, statusReply: Reply) {
    const detach = h.client.attach();
    h.es().open();
    h.es().send(idleMsg({ outcome: 'success', finishedAt: 100 }));
    h.replies['/api/scan'].push({ status: 200 });
    h.replies['/api/status'].push(statusReply);
    await h.client.start();
    return detach;
}
const ok = (body: unknown): Spec => ({ status: 200, body });

describe('status response ownership (late responses)', () => {
    test('delayed running GET resolving after SSE terminal stays in cooldown, one refresh', async () => {
        const h = harness();
        const late = deferred();
        await startWith(h, late.reply);
        h.es().send(doneMsg('success', 200));
        expect(h.completions).toBe(1);
        expect(h.client.state.phase).toBe('cooldown');
        late.release(ok(runningMsg(7)));
        await h.flush();
        expect(h.client.state.phase).toBe('cooldown');
        expect(h.client.state.notice?.kind).toBe('success');
        expect(h.completions).toBe(1);
    });

    test('duplicate terminal after the late response cannot leave the client running', async () => {
        const h = harness();
        const late = deferred();
        await startWith(h, late.reply);
        h.es().send(doneMsg('success', 200));
        late.release(ok(runningMsg(7)));
        await h.flush();
        h.es().send(doneMsg('success', 200));
        expect(h.client.state.phase).toBe('cooldown');
        await h.advance(10_000);
        expect(h.client.state.phase).toBe('idle');
        expect(h.client.state.canStart).toBe(true);
        expect(h.completions).toBe(1);
    });

    test('delayed terminal GET resolving after last detach publishes and refreshes nothing', async () => {
        const h = harness();
        const late = deferred();
        const detach = await startWith(h, late.reply);
        detach();
        const emitted = h.states.length;
        late.release(ok(doneMsg('success', 200)));
        await h.flush();
        expect(h.completions).toBe(0);
        expect(h.states.length).toBe(emitted);
        expect(h.client.state.notice).toBeNull();
    });

    test('old request resolving after detach/reattach is ignored', async () => {
        const h = harness();
        const late = deferred();
        const detach = await startWith(h, late.reply);
        detach();
        h.client.attach();
        h.es().open();
        late.release(ok(doneMsg('success', 200)));
        await h.flush();
        expect(h.completions).toBe(0);
        expect(h.client.state.notice?.kind).not.toBe('success');
    });

    test('old request resolving after a subsequent scan started cannot finish that scan', async () => {
        const h = harness();
        const late = deferred();
        await startWith(h, late.reply);
        h.es().send(doneMsg('success', 200));
        await h.advance(10_000);
        h.replies['/api/scan'].push({ status: 200 });
        h.replies['/api/status'].push(ok(runningMsg()));
        await h.client.start();
        expect(h.client.state.phase).toBe('running');
        late.release(ok(doneMsg('success', 999)));
        await h.flush();
        expect(h.client.state.phase).toBe('running');
        expect(h.completions).toBe(1);
    });
});

describe('status request and polling bounds', () => {
    async function startPolling(h: ReturnType<typeof harness>, ...replies: Reply[]) {
        const detach = await startWith(h, ok(runningMsg()));
        h.replies['/api/status'].push(...replies);
        h.es().fail();
        await h.flush();
        return detach;
    }

    test('a never-resolving fetch times out, surfaces lost contact, and unlocks rescan', async () => {
        const h = harness({ maxPollFailures: 3 });
        await startPolling(h, 'hang', 'hang', 'hang');
        expect(h.client.state.polling).toBe(true);
        await h.advance(40_000);
        expect(h.client.state.notice?.kind).toBe('disconnected');
        expect(h.client.state.phase).toBe('idle');
        expect(h.client.state.canStart).toBe(true);
        expect(h.client.state.polling).toBe(false);
        expect(h.signals.some(s => s?.aborted)).toBe(true);
        expect(h.pending()).toBe(0);
    });

    test('a response whose JSON body never resolves takes the same path', async () => {
        const h = harness({ maxPollFailures: 3 });
        await startPolling(h, 'hangBody', 'hangBody', 'hangBody');
        await h.advance(40_000);
        expect(h.client.state.notice?.kind).toBe('disconnected');
        expect(h.client.state.canStart).toBe(true);
        expect(h.pending()).toBe(0);
    });

    test('continuous successful running responses still hit the hard polling cap', async () => {
        const h = harness({ maxPollMs: 60_000 });
        await startPolling(h, ...Array.from({ length: 60 }, () => ok(runningMsg(3))));
        await h.advance(50_000);
        expect(h.client.state.phase).toBe('running');
        await h.advance(15_000);
        expect(h.client.state.notice?.kind).toBe('disconnected');
        expect(h.client.state.canStart).toBe(true);
        expect(h.pending()).toBe(0);
        const gets = h.statusGets();
        await h.advance(60_000);
        expect(h.statusGets()).toBe(gets);
    });

    test('a hung request cannot postpone the polling deadline', async () => {
        const h = harness({ maxPollMs: 4000, requestTimeoutMs: 600_000, maxPollFailures: 99 });
        await startPolling(h, 'hang');
        await h.advance(4000);
        expect(h.client.state.notice?.kind).toBe('disconnected');
        expect(h.client.state.canStart).toBe(true);
        expect(h.signals[h.signals.length - 1]?.aborted).toBe(true);
    });

    test('detach cancels the deadline, request timeout and the in-flight request', async () => {
        const h = harness();
        const detach = await startPolling(h, 'hang');
        const signal = h.signals[h.signals.length - 1];
        expect(h.pending()).toBeGreaterThan(0);
        detach();
        expect(signal?.aborted).toBe(true);
        expect(h.pending()).toBe(0);
    });

    test('SSE reconnect cancels polling resources', async () => {
        const h = harness();
        await startPolling(h, 'hang');
        const signal = h.signals[h.signals.length - 1];
        h.es().open();
        expect(signal?.aborted).toBe(true);
        expect(h.client.state.polling).toBe(false);
        expect(h.pending()).toBe(0);
    });

    test('a response resolving after its timeout is ignored', async () => {
        const h = harness({ maxPollFailures: 5 });
        const late = deferred();
        await startPolling(h, late.reply);
        await h.advance(5000);
        late.release(ok(doneMsg('success', 200)));
        await h.flush();
        expect(h.completions).toBe(0);
        expect(h.client.state.phase).toBe('running');
    });

    test('scan POST stays a plain method-only fetch', async () => {
        const h = harness();
        await startWith(h, ok(runningMsg()));
        const post = h.calls.find(c => c.url === '/api/scan');
        expect(post?.method).toBe('POST');
        expect(h.signals[h.calls.indexOf(post!)]).toBeUndefined();
    });
});

describe('grid refresh after scan keeps filters', () => {
    const filters: FilterState = {
        search: 'cat', folderId: 'F1', includedTags: ['a'], excludedTags: ['b'], tagRule: 'any',
        color: '#ff0000', colorAccuracy: 40, sortBy: 'name', sortOrder: 'asc', specialFilter: null, recursive: true,
        includedShapes: [], excludedShapes: [], customRatio: { width: 4, height: 3 }, includedTypes: [], excludedTypes: [],
    };

    test('reload() starts a new generation with the same filters object and aborts in-flight work', async () => {
        const urls: string[] = [];
        const signals: AbortSignal[] = [];
        const fetchFn: GridFetch = (url, init) => {
            urls.push(url); signals.push(init.signal);
            return Promise.resolve(new Response(JSON.stringify({ items: [{ id: 'x' }], totalItems: 1, relevantTags: [], relevantTagCounts: {} })));
        };
        const ctl = new GridRequestController<{ id: string }>({ fetchFn, onChange: () => { } });
        ctl.reload(); // before first refresh: no-op
        expect(urls.length).toBe(0);
        ctl.refresh(filters, true);
        const gen = ctl.generation;
        ctl.reload();
        expect(ctl.generation).toBe(gen + 1);
        expect(signals[0].aborted).toBe(true);
        await new Promise(r => setTimeout(r, 0));
        expect(urls.length).toBe(2);
        expect(urls[1]).toBe(urls[0]);
        expect(urls[1]).toContain('search=cat');
        expect(urls[1]).toContain('folderId=F1');
        expect(urls[1]).toContain('recursive=true');
        expect(urls[1]).toContain('page=1');
    });

    test('reload() preserves a disabled (locked) view without fetching', () => {
        let calls = 0;
        const ctl = new GridRequestController<{ id: string }>({
            fetchFn: () => { calls++; return Promise.reject(new Error('no')); },
            onChange: () => { },
        });
        ctl.refresh(filters, false);
        ctl.reload();
        expect(calls).toBe(0);
        expect(ctl.state.enabled).toBe(false);
    });

    test('scan completion callback drives a single controller reload', async () => {
        let reloads = 0;
        const h = harness();
        const client = new ScanClient({
            fetchFn: async () => new Response(null, { status: 200 }),
            createEventSource: () => { const es = new FakeES(); h.sources.push(es); return es; },
            schedule: () => () => { },
            now: () => 0,
            onScanComplete: () => { reloads++; },
            onChange: () => { },
        });
        client.attach();
        const es = h.sources[h.sources.length - 1];
        es.send(idleMsg());
        es.send(runningMsg());
        es.send(doneMsg('success', 1));
        es.send(doneMsg('success', 1));
        expect(reloads).toBe(1);
    });
});
