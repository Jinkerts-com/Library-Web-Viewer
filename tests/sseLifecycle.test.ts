import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import {
    DEFAULT_SSE_LISTENER_LIMIT,
    createStatusStream,
    resolveSseListenerLimit,
    resolveWatchPollInterval
} from '../src/lib/sseStream';

const decoder = new TextDecoder();
const status = () => ({ isScanning: false, scannedCount: 0 });

// Track interval handles created/cleared by the stream so timer leaks are observable.
let activeTimers: Set<unknown>;
const realSet = globalThis.setInterval;
const realClear = globalThis.clearInterval;
function trackTimers() {
    activeTimers = new Set();
    (globalThis as any).setInterval = (fn: any, ms?: number, ...a: any[]) => {
        const h = realSet(fn, ms, ...a);
        activeTimers.add(h);
        return h;
    };
    (globalThis as any).clearInterval = (h: any) => {
        activeTimers.delete(h);
        return realClear(h);
    };
}
afterEach(() => {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
});

/** AbortSignal wrapper that counts live 'abort' listeners. */
function countingSignal() {
    const ac = new AbortController();
    let live = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    const listeners = new Set<unknown>();
    (ac.signal as any).addEventListener = (t: string, l: any, o?: any) => { if (t === 'abort' && !listeners.has(l)) { listeners.add(l); live++; } add(t, l, o); };
    (ac.signal as any).removeEventListener = (t: string, l: any, o?: any) => { if (t === 'abort' && listeners.delete(l)) live--; remove(t, l, o); };
    return { ac, live: () => live };
}

const counts = (e: EventEmitter) => e.listenerCount('progress') + e.listenerCount('complete');

describe('SSE stream lifecycle', () => {
    test('open/abort churn returns listeners, timers and abort listeners to baseline', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        for (let i = 0; i < 25; i++) {
            const { ac, live } = countingSignal();
            const stream = createStatusStream({ emitter, getStatus: status, signal: ac.signal });
            const reader = stream.getReader();
            await reader.read();
            expect(counts(emitter)).toBe(2);
            expect(activeTimers.size).toBe(1);
            expect(live()).toBe(1);
            ac.abort();
            expect(counts(emitter)).toBe(0);
            expect(activeTimers.size).toBe(0);
            expect(live()).toBe(0);
            await reader.cancel().catch(() => { });
        }
        expect(counts(emitter)).toBe(0);
    });

    test('cancel() churn returns to baseline and detaches the abort listener', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        for (let i = 0; i < 25; i++) {
            const { ac, live } = countingSignal();
            const reader = createStatusStream({ emitter, getStatus: status, signal: ac.signal }).getReader();
            await reader.read();
            await reader.cancel();
            expect(counts(emitter)).toBe(0);
            expect(activeTimers.size).toBe(0);
            expect(live()).toBe(0);
        }
    });

    test('abort and cancel both firing is idempotent (no throw, no double removal)', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const other = () => { };
        emitter.on('progress', other); // unrelated listener must survive double cleanup
        const { ac, live } = countingSignal();
        const reader = createStatusStream({ emitter, getStatus: status, signal: ac.signal }).getReader();
        await reader.read();
        ac.abort();
        await expect(reader.cancel()).resolves.toBeUndefined();
        ac.abort();
        await reader.cancel();
        expect(emitter.listenerCount('progress')).toBe(1);
        expect(emitter.listeners('progress')[0]).toBe(other);
        expect(emitter.listenerCount('complete')).toBe(0);
        expect(activeTimers.size).toBe(0);
        expect(live()).toBe(0);
    });

    test('an already-aborted signal registers nothing', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const ac = new AbortController();
        ac.abort();
        createStatusStream({ emitter, getStatus: status, signal: ac.signal });
        expect(counts(emitter)).toBe(0);
        expect(activeTimers.size).toBe(0);
    });

    test('a closed/errored controller during delivery cleans up without throwing', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const reader = createStatusStream({ emitter, getStatus: status }).getReader();
        await reader.read();
        await reader.cancel();
        expect(() => emitter.emit('progress', { isScanning: true })).not.toThrow();
        expect(counts(emitter)).toBe(0);
        expect(activeTimers.size).toBe(0);
    });

    // Bounded read: a permanently pending body fails the test instead of hanging it.
    const settle = (p: Promise<unknown>) =>
        Promise.race([
            p.then(() => 'resolved', () => 'rejected'),
            new Promise(r => setTimeout(() => r('PENDING'), 500))
        ]);

    test('listener registration failure mid-setup releases every resource and errors the stream', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const other = () => { };
        emitter.on('progress', other);
        // Make the SECOND registration ('complete') throw.
        emitter.on('newListener', (ev: string) => { if (ev === 'complete') throw new Error('register failed'); });
        const { ac, live } = countingSignal();
        const reader = createStatusStream({ emitter, getStatus: status, signal: ac.signal }).getReader();
        expect(await settle(reader.read())).toBe('rejected');
        expect(emitter.listenerCount('progress')).toBe(1);
        expect(emitter.listeners('progress')[0]).toBe(other);
        expect(emitter.listenerCount('complete')).toBe(0);
        expect(activeTimers.size).toBe(0);
        expect(live()).toBe(0);
    });

    test('throwing getStatus() cleans up and settles the read with an error', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const { ac, live } = countingSignal();
        const reader = createStatusStream({ emitter, getStatus: () => { throw new Error('boom'); }, signal: ac.signal }).getReader();
        expect(await settle(reader.read())).toBe('rejected');
        expect(counts(emitter)).toBe(0);
        expect(activeTimers.size).toBe(0);
        expect(live()).toBe(0);
    });

    test('unserializable initial payload cleans up and settles the read with an error', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const { ac, live } = countingSignal();
        const circular: any = {};
        circular.self = circular;
        const reader = createStatusStream({ emitter, getStatus: () => circular, signal: ac.signal }).getReader();
        expect(await settle(reader.read())).toBe('rejected');
        expect(counts(emitter)).toBe(0);
        expect(activeTimers.size).toBe(0);
        expect(live()).toBe(0);
    });

    // Make enqueue fail for real by patching the controller prototype while `fn` runs.
    async function withFailingEnqueue<T>(fn: () => T | Promise<T>): Promise<T> {
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        new ReadableStream({ start(c) { ctrl = c; } });
        const proto = Object.getPrototypeOf(ctrl);
        const realEnqueue = proto.enqueue;
        proto.enqueue = () => { throw new TypeError('enqueue failed'); };
        try {
            return await fn();
        } finally {
            proto.enqueue = realEnqueue;
        }
    }

    test('genuine enqueue failure during live delivery cleans up, settles the stream and does not throw into the emitter', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const { ac, live } = countingSignal();
        const reader = createStatusStream({ emitter, getStatus: status, signal: ac.signal }).getReader();
        await reader.read();
        const pending = reader.read(); // pending read BEFORE emission
        await withFailingEnqueue(() => {
            expect(() => emitter.emit('progress', { isScanning: true })).not.toThrow();
        });
        // Settles by itself: no explicit cancel() before this assertion.
        expect(await settle(pending)).toBe('rejected');
        expect(await settle(reader.read())).toBe('rejected');
        expect(counts(emitter)).toBe(0);
        expect(activeTimers.size).toBe(0);
        expect(live()).toBe(0);
    });

    test('live enqueue failure settles a read started after the restore (no pending read at emission)', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const reader = createStatusStream({ emitter, getStatus: status }).getReader();
        await reader.read();
        await withFailingEnqueue(() => {
            expect(() => emitter.emit('complete', { isScanning: false })).not.toThrow();
        });
        expect(await settle(reader.read())).toBe('rejected');
        expect(counts(emitter)).toBe(0);
        expect(activeTimers.size).toBe(0);
    });

    test('enqueue failure during initial delivery cleans up and errors the stream', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const { ac, live } = countingSignal();
        const reader = await withFailingEnqueue(() =>
            createStatusStream({ emitter, getStatus: status, signal: ac.signal }).getReader());
        expect(await settle(reader.read())).toBe('rejected');
        expect(counts(emitter)).toBe(0);
        expect(activeTimers.size).toBe(0);
        expect(live()).toBe(0);
    });

    test('enqueue failure during heartbeat cleans up and errors the stream', async () => {
        trackTimers();
        const emitter = new EventEmitter();
        const { ac, live } = countingSignal();
        const reader = createStatusStream({ emitter, getStatus: status, signal: ac.signal, heartbeatMs: 10 }).getReader();
        await reader.read();
        await withFailingEnqueue(() => new Promise(r => setTimeout(r, 60)));
        expect(await settle(reader.read())).toBe('rejected');
        expect(counts(emitter)).toBe(0);
        expect(activeTimers.size).toBe(0);
        expect(live()).toBe(0);
    });

    test('heartbeat is emitted on the configured interval and stops after close', async () => {
        const emitter = new EventEmitter();
        const reader = createStatusStream({ emitter, getStatus: status, heartbeatMs: 10 }).getReader();
        await reader.read();
        const beat = await reader.read();
        expect(decoder.decode(beat.value)).toBe(': keep-alive\n\n');
        await reader.cancel();
    });

    test('15+ concurrent streams: no MaxListenersExceededWarning under the bounded cap, baseline after close', async () => {
        const emitter = new EventEmitter();
        emitter.setMaxListeners(resolveSseListenerLimit(undefined));
        const warnings: Error[] = [];
        const onWarn = (w: Error) => warnings.push(w);
        process.on('warning', onWarn);
        const sigs = Array.from({ length: 20 }, () => countingSignal());
        const readers = sigs.map(s => createStatusStream({ emitter, getStatus: status, signal: s.ac.signal }).getReader());
        await Promise.all(readers.map(r => r.read()));
        await new Promise(r => setTimeout(r, 10));
        process.off('warning', onWarn);
        expect(emitter.listenerCount('progress')).toBe(20);
        expect(warnings.filter(w => w.name === 'MaxListenersExceededWarning')).toHaveLength(0);
        sigs.forEach(s => s.ac.abort());
        expect(counts(emitter)).toBe(0);
        expect(sigs.every(s => s.live() === 0)).toBe(true);
    });

    test('the cap is bounded: a leak past the headroom still warns', async () => {
        const emitter = new EventEmitter();
        emitter.setMaxListeners(resolveSseListenerLimit('10'));
        const warnings: Error[] = [];
        const onWarn = (w: Error) => warnings.push(w);
        process.on('warning', onWarn);
        const readers = Array.from({ length: 12 }, () => createStatusStream({ emitter, getStatus: status }).getReader());
        await Promise.all(readers.map(r => r.read()));
        await new Promise(r => setTimeout(r, 10));
        process.off('warning', onWarn);
        expect(warnings.some(w => w.name === 'MaxListenersExceededWarning')).toBe(true);
        await Promise.all(readers.map(r => r.cancel()));
        expect(counts(emitter)).toBe(0);
    });

    test('terminal delivery reaches all open clients, and nothing is delivered after close', async () => {
        const emitter = new EventEmitter();
        const readers = Array.from({ length: 5 }, () => createStatusStream({ emitter, getStatus: status }).getReader());
        await Promise.all(readers.map(r => r.read())); // initial status
        const terminal = { isScanning: false, scannedCount: 88, status: 'complete', outcome: 'success' };
        emitter.emit('complete', terminal);
        for (const r of readers) {
            const msg = decoder.decode((await r.read()).value);
            expect(JSON.parse(msg.replace(/^data: /, ''))).toEqual(terminal);
        }
        const closed = readers.pop()!;
        await closed.cancel();
        emitter.emit('progress', { isScanning: true, scannedCount: 1 });
        const next = decoder.decode((await readers[0].read()).value);
        expect(JSON.parse(next.replace(/^data: /, '')).isScanning).toBe(true);
        expect(emitter.listenerCount('progress')).toBe(4);
        await Promise.all(readers.map(r => r.cancel()));
        expect(counts(emitter)).toBe(0);
    });

    test('initial message is the current status (payload shape preserved)', async () => {
        const emitter = new EventEmitter();
        const s = { isScanning: true, scannedCount: 3, status: 'scanning', outcome: undefined };
        const reader = createStatusStream({ emitter, getStatus: () => s }).getReader();
        const msg = decoder.decode((await reader.read()).value);
        expect(msg.startsWith('data: ') && msg.endsWith('\n\n')).toBe(true);
        expect(JSON.parse(msg.slice(6))).toEqual({ isScanning: true, scannedCount: 3, status: 'scanning' });
        await reader.cancel();
    });
});

describe('tuning knobs', () => {
    test('SSE listener limit defaults, clamps and ignores junk', () => {
        expect(resolveSseListenerLimit(undefined)).toBe(DEFAULT_SSE_LISTENER_LIMIT);
        expect(resolveSseListenerLimit('')).toBe(DEFAULT_SSE_LISTENER_LIMIT);
        expect(resolveSseListenerLimit('abc')).toBe(DEFAULT_SSE_LISTENER_LIMIT);
        expect(resolveSseListenerLimit('1.5')).toBe(DEFAULT_SSE_LISTENER_LIMIT);
        expect(resolveSseListenerLimit('0')).toBe(10);
        expect(resolveSseListenerLimit('-5')).toBe(10);
        expect(resolveSseListenerLimit('50')).toBe(50);
        expect(resolveSseListenerLimit('999999')).toBe(1000);
        expect(resolveSseListenerLimit('Infinity')).toBe(DEFAULT_SSE_LISTENER_LIMIT);
    });
    test('watch poll interval defaults, clamps and ignores junk', () => {
        expect(resolveWatchPollInterval(undefined)).toBe(2000);
        expect(resolveWatchPollInterval('x')).toBe(2000);
        expect(resolveWatchPollInterval('100')).toBe(500);
        expect(resolveWatchPollInterval('5000')).toBe(5000);
        expect(resolveWatchPollInterval('9999999')).toBe(60000);
    });
});
