import type { EventEmitter } from 'events';

export const HEARTBEAT_MS = 15000;

/** Default per-event listener count at which Node warns about a possible leak (one listener per open stream). */
export const DEFAULT_SSE_LISTENER_LIMIT = 100;
const MIN_SSE_LISTENER_LIMIT = 10;
const MAX_SSE_LISTENER_LIMIT = 1000;

/**
 * Node warns once an event has more than 10 listeners, but every open SSE stream legitimately
 * holds one 'progress' and one 'complete' listener. The cap is raised to a bounded, documented
 * headroom (default 100, clamped to 10..1000) instead of being disabled (0/Infinity), so a real
 * leak still triggers MaxListenersExceededWarning once it grows past the headroom.
 */
export function resolveSseListenerLimit(raw: string | undefined): number {
    const n = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isInteger(n)) return DEFAULT_SSE_LISTENER_LIMIT;
    return Math.min(MAX_SSE_LISTENER_LIMIT, Math.max(MIN_SSE_LISTENER_LIMIT, n));
}

/** Watcher polling interval in ms: default 2000, clamped to 500..60000; invalid values fall back to the default. */
export function resolveWatchPollInterval(raw: string | undefined): number {
    const n = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isInteger(n)) return 2000;
    return Math.min(60000, Math.max(500, n));
}

export interface StatusStreamOptions {
    emitter: EventEmitter;
    getStatus: () => unknown;
    signal?: AbortSignal;
    heartbeatMs?: number;
}

/**
 * Builds the SSE body for scan status. Cleanup is idempotent and is reached from every exit path
 * (client abort, cancel(), enqueue failure): it clears the heartbeat, removes both emitter listeners
 * and detaches the abort listener from the request signal.
 */
export function createStatusStream(opts: StatusStreamOptions): ReadableStream<Uint8Array> {
    const { emitter, getStatus, signal, heartbeatMs = HEARTBEAT_MS } = opts;
    let cleanup: () => void = () => { };

    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            let done = false;

            let interval: ReturnType<typeof setInterval> | undefined;

            // A thrown enqueue does not guarantee the stream is closed/errored, so release resources AND
            // explicitly error the stream (contained) so a pending or later read always settles.
            const fail = (err: unknown) => {
                cleanup();
                try { controller.error(err); } catch { }
            };

            // Serialization errors propagate to the caller; enqueue failures settle the stream via fail().
            const send = (data: unknown) => {
                if (done) return;
                const chunk = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
                try {
                    controller.enqueue(chunk);
                } catch (err) {
                    fail(err);
                }
            };

            // Live events arrive via emitter.emit(), so a failure must never throw into the emitter:
            // clean up and error the stream so the reader settles.
            const listener = (data: unknown) => {
                try {
                    send(data);
                } catch (err) {
                    cleanup();
                    try { controller.error(err); } catch { }
                }
            };

            cleanup = () => {
                if (done) return;
                done = true;
                if (interval !== undefined) clearInterval(interval);
                emitter.removeListener('progress', listener);
                emitter.removeListener('complete', listener);
                signal?.removeEventListener('abort', cleanup);
            };

            if (signal?.aborted) {
                done = true;
                try { controller.close(); } catch { }
                return;
            }

            // Status retrieval/delivery and listener/abort registration are ONE setup operation: any failure
            // releases every acquired resource and errors the stream so the reader never waits forever.
            try {
                interval = setInterval(() => {
                    if (done) return;
                    try {
                        controller.enqueue(encoder.encode(`: keep-alive\n\n`));
                    } catch (err) {
                        fail(err);
                    }
                }, heartbeatMs);

                // Every message (including the terminal 'complete' one, which carries isScanning:false plus
                // outcome/error) is a superset of { isScanning, scannedCount }, so older readers keep working.
                send(getStatus());
                if (done) return;

                emitter.on('progress', listener);
                emitter.on('complete', listener);
                signal?.addEventListener('abort', cleanup);
            } catch (err) {
                cleanup();
                try { controller.error(err); } catch { }
            }
        },
        cancel() {
            cleanup();
        }
    });
}
