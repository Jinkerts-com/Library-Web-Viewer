/**
 * Browser-side rescan state machine, kept free of React/DOM globals so it can be
 * tested with injected fetch, EventSource and timers.
 *
 * Phases: idle -> requesting (POST /api/scan in flight) -> running -> cooldown -> idle.
 * Only `idle` accepts a click, so repeated clicks cannot fire duplicate POSTs.
 * Outcomes come from the server's status messages (SSE, with bounded polling of
 * /api/status as a fallback), never from the POST response alone.
 */

export type ScanPhase = 'idle' | 'requesting' | 'running' | 'cooldown';

export type ScanNoticeKind =
    | 'success' | 'partial' | 'failure'
    | 'busy' | 'rate_limited' | 'unconfigured' | 'network' | 'error' | 'disconnected';

export interface ScanNotice {
    kind: ScanNoticeKind;
    message: string;
    failedItems?: number;
}

/** Notices announced by the global alert (ScanProgress); all others use the sidebar status region. */
export const isAlertNotice = (kind: ScanNoticeKind): boolean =>
    kind === 'failure' || kind === 'partial' || kind === 'disconnected';

export interface ScanUiState {
    phase: ScanPhase;
    scannedCount: number;
    totalItems: number | null;
    notice: ScanNotice | null;
    /** Seconds left in the cooldown / rate-limit window (0 outside `cooldown`). */
    cooldownSeconds: number;
    /** True while status is being polled because the event stream is down. */
    polling: boolean;
    canStart: boolean;
}

export interface ScanStatusMessage {
    isScanning: boolean;
    scannedCount: number;
    totalItems: number | null;
    outcome: 'success' | 'partial' | 'failure' | null;
    error: string | null;
    failedItems: number;
    finishedAt: number | null;
}

export interface EventSourceLike {
    onopen: ((ev: any) => void) | null;
    onmessage: ((ev: any) => void) | null;
    onerror: ((ev: any) => void) | null;
    close(): void;
}

export interface ScanClientDeps {
    fetchFn: (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<Response>;
    /** Return null when EventSource is unavailable; the client then relies on polling. */
    createEventSource: (url: string) => EventSourceLike | null;
    /** Schedule `fn` after `ms`; returns a cancel function. */
    schedule: (fn: () => void, ms: number) => () => void;
    now: () => number;
    /** Called exactly once per completed scan with outcome success or partial. */
    onScanComplete: () => void | Promise<void>;
    onChange: (state: ScanUiState) => void;
    pollIntervalMs?: number;
    cooldownMs?: number;
    /** Consecutive failed polls before giving up on a scan believed running. */
    maxPollFailures?: number;
    /** Hard cap on one continuous polling session, enforced by its own timer. */
    maxPollMs?: number;
    /** Bound on one status request, covering both the response and its JSON body. */
    requestTimeoutMs?: number;
}

export const SCAN_COOLDOWN_MS = 10_000;
export const SCAN_POLL_INTERVAL_MS = 3_000;
export const SCAN_MAX_POLL_FAILURES = 5;
export const SCAN_MAX_POLL_MS = 30 * 60_000;
export const SCAN_REQUEST_TIMEOUT_MS = 10_000;

/** One outstanding GET /api/status; `cancel` aborts it and clears its timeout. */
interface StatusRequest { cancel: () => void }
const MAX_RETRY_AFTER_SECONDS = 3600;

export function parseScanStatus(data: unknown): ScanStatusMessage | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (typeof d.isScanning !== 'boolean') return null;
    const outcome = d.outcome === 'success' || d.outcome === 'partial' || d.outcome === 'failure' ? d.outcome : null;
    const total = typeof d.totalItems === 'number' ? d.totalItems : typeof d.total === 'number' ? d.total : null;
    return {
        isScanning: d.isScanning,
        scannedCount: typeof d.scannedCount === 'number' ? d.scannedCount : 0,
        totalItems: total,
        outcome,
        error: typeof d.error === 'string' ? d.error : null,
        failedItems: typeof d.failedItems === 'number' ? d.failedItems : 0,
        finishedAt: typeof d.finishedAt === 'number' ? d.finishedAt : null,
    };
}

/** Seconds from a Retry-After header; falls back to `fallback` when missing/invalid. */
export function parseRetryAfter(value: string | null, fallback: number): number {
    const n = value === null ? NaN : Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, MAX_RETRY_AFTER_SECONDS);
}

export class ScanClient {
    private readonly deps: ScanClientDeps;
    private readonly cooldownMs: number;
    private readonly pollIntervalMs: number;
    private readonly maxPollFailures: number;
    private readonly maxPollMs: number;
    private readonly requestTimeoutMs: number;

    private phase: ScanPhase = 'idle';
    private scannedCount = 0;
    private totalItems: number | null = null;
    private notice: ScanNotice | null = null;
    private cooldownEnds = 0;
    private cooldownSeconds = 0;
    private cancelCooldownTick: (() => void) | null = null;

    private attached = 0;
    private es: EventSourceLike | null = null;
    private sseHealthy = false;

    /** A scan is believed to be in progress (started by us or seen via status). */
    private sawRunning = false;
    /** finishedAt of the last terminal outcome already reported; undefined = no baseline yet. */
    private lastFinishedAt: number | null | undefined = undefined;

    private polling = false;
    private pollToken = 0;
    private pollFailures = 0;
    private cancelPollTimer: (() => void) | null = null;
    private cancelPollDeadline: (() => void) | null = null;
    /**
     * Observation ownership: every status request captures this value and may only
     * publish while it is unchanged. It is bumped on terminal settlement, new scan,
     * stream (re)connect, last detach and disposal, so a late response can never
     * resurrect or alter a scan it did not observe.
     */
    private statusEpoch = 0;
    private readonly inflight = new Set<StatusRequest>();
    private disposed = false;

    constructor(deps: ScanClientDeps) {
        this.deps = deps;
        this.cooldownMs = deps.cooldownMs ?? SCAN_COOLDOWN_MS;
        this.pollIntervalMs = deps.pollIntervalMs ?? SCAN_POLL_INTERVAL_MS;
        this.maxPollFailures = deps.maxPollFailures ?? SCAN_MAX_POLL_FAILURES;
        this.maxPollMs = deps.maxPollMs ?? SCAN_MAX_POLL_MS;
        this.requestTimeoutMs = deps.requestTimeoutMs ?? SCAN_REQUEST_TIMEOUT_MS;
    }

    get state(): ScanUiState {
        return {
            phase: this.phase,
            scannedCount: this.scannedCount,
            totalItems: this.totalItems,
            notice: this.notice,
            cooldownSeconds: this.cooldownSeconds,
            polling: this.polling,
            canStart: this.phase === 'idle',
        };
    }

    /** Reference-counted: the event stream is open only while something is mounted. */
    attach(): () => void {
        if (this.disposed) return () => { };
        this.attached++;
        if (this.attached === 1) this.openStream();
        let detached = false;
        return () => {
            if (detached) return;
            detached = true;
            this.attached--;
            if (this.attached === 0) {
                this.closeStream();
                this.invalidateStatusRequests();
                this.stopPolling();
            }
        };
    }

    dismissNotice(): void {
        if (this.notice) {
            this.notice = null;
            this.emit();
        }
    }

    /** User click. Ignored unless idle, so double clicks produce exactly one POST. */
    async start(): Promise<void> {
        if (this.disposed || this.phase !== 'idle') return;
        this.invalidateStatusRequests(); // responses about an earlier scan must not touch this one
        this.phase = 'requesting';
        this.notice = null;
        this.scannedCount = 0;
        this.totalItems = null;
        this.emit();

        let res: Response;
        try {
            res = await this.deps.fetchFn('/api/scan', { method: 'POST' });
        } catch {
            if (this.disposed || this.phase !== 'requesting') return;
            this.phase = 'idle';
            this.notice = { kind: 'network', message: 'Could not reach the server. Check your connection and try again.' };
            this.emit();
            return;
        }
        if (this.disposed) return;

        // A terminal status message may already have ended this request's scan.
        const stillRequesting = this.phase === 'requesting';

        if (res.status === 200 || res.status === 409) {
            if (!stillRequesting) return;
            this.sawRunning = true;
            this.phase = 'running';
            this.notice = res.status === 409 ? { kind: 'busy', message: 'A scan is already running.' } : null;
            this.emit();
            // Reconcile in case the stream missed the start or a very fast finish.
            if (this.sseHealthy) void this.pollOnce(); else this.maybeStartPolling();
            return;
        }

        if (!stillRequesting) return;

        if (res.status === 429) {
            const seconds = parseRetryAfter(res.headers.get('Retry-After'), Math.ceil(this.cooldownMs / 1000));
            this.notice = { kind: 'rate_limited', message: 'Too many rescan requests.' };
            this.startCooldown(seconds * 1000);
            return;
        }

        this.phase = 'idle';
        if (res.status === 503) {
            this.notice = { kind: 'unconfigured', message: 'Library not configured. Set LIBRARY_PATH and restart the server.' };
        } else {
            this.notice = { kind: 'error', message: `Could not start the scan (HTTP ${res.status}). Try again.` };
        }
        this.emit();
    }

    dispose(): void {
        this.disposed = true;
        this.attached = 0;
        this.closeStream();
        this.invalidateStatusRequests();
        this.stopPolling();
        this.cancelCooldownTick?.();
        this.cancelCooldownTick = null;
    }

    /** Feed a parsed status message from SSE or polling. */
    ingest(msg: ScanStatusMessage): void {
        if (this.disposed) return;

        if (msg.isScanning) {
            this.sawRunning = true;
            this.scannedCount = msg.scannedCount;
            this.totalItems = msg.totalItems;
            if (this.phase !== 'running') {
                this.cancelCooldownTick?.();
                this.cancelCooldownTick = null;
                this.cooldownSeconds = 0;
                this.phase = 'running';
                if (this.notice?.kind !== 'busy') this.notice = null;
            }
            this.emit();
            return;
        }

        const awaiting = this.sawRunning || (this.phase === 'requesting' && this.lastFinishedAt !== undefined);
        const isNew = msg.outcome !== null && (msg.finishedAt === null || msg.finishedAt !== this.lastFinishedAt);

        if (awaiting && isNew) {
            this.finish(msg);
            return;
        }

        if (this.sawRunning && msg.outcome === null) {
            // Server no longer scanning and has no outcome (e.g. it restarted): nothing to report.
            this.sawRunning = false;
            if (this.phase === 'running') { this.phase = 'idle'; this.notice = null; }
            this.emit();
            return;
        }

        if (this.phase !== 'requesting') this.lastFinishedAt = msg.finishedAt;
    }

    private finish(msg: ScanStatusMessage): void {
        this.sawRunning = false;
        this.lastFinishedAt = msg.finishedAt;
        this.invalidateStatusRequests(); // anything still in flight predates this terminal state

        if (msg.outcome === 'success') {
            this.notice = { kind: 'success', message: 'Library rescanned.' };
        } else if (msg.outcome === 'partial') {
            this.notice = {
                kind: 'partial',
                message: `Rescan finished with problems: ${msg.failedItems} item(s) could not be read.`,
                failedItems: msg.failedItems,
            };
        } else {
            this.notice = { kind: 'failure', message: msg.error || 'The library scan failed.' };
        }

        if (msg.outcome === 'success' || msg.outcome === 'partial') {
            try {
                const r = this.deps.onScanComplete();
                if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => { });
            } catch { /* refresh is best effort */ }
        }
        this.startCooldown(this.cooldownMs);
        this.stopPollingIfSettled();
    }

    private startCooldown(ms: number): void {
        this.cancelCooldownTick?.();
        this.phase = 'cooldown';
        this.cooldownEnds = this.deps.now() + ms;
        this.cooldownSeconds = Math.max(1, Math.ceil(ms / 1000));
        this.emit();
        this.scheduleCooldownTick();
    }

    private scheduleCooldownTick(): void {
        this.cancelCooldownTick = this.deps.schedule(() => {
            this.cancelCooldownTick = null;
            if (this.disposed || this.phase !== 'cooldown') return;
            const remainingMs = this.cooldownEnds - this.deps.now();
            if (remainingMs <= 0) {
                this.phase = 'idle';
                this.cooldownSeconds = 0;
                // A rate-limit notice is only meaningful while the window is open.
                if (this.notice?.kind === 'rate_limited') this.notice = null;
                this.emit();
                return;
            }
            this.cooldownSeconds = Math.ceil(remainingMs / 1000);
            this.emit();
            this.scheduleCooldownTick();
        }, 1000);
    }

    private openStream(): void {
        let es: EventSourceLike | null = null;
        try { es = this.deps.createEventSource('/api/status/stream'); } catch { es = null; }
        this.es = es;
        if (!es) { this.sseHealthy = false; this.maybeStartPolling(); return; }
        es.onopen = () => {
            this.sseHealthy = true;
            this.invalidateStatusRequests(); // the stream's snapshot supersedes pending reads
            this.stopPolling();
        };
        es.onmessage = (ev) => {
            this.sseHealthy = true;
            if (this.polling) this.stopPolling(); // takeover from polling invalidates its requests
            let parsed: ScanStatusMessage | null = null;
            try { parsed = parseScanStatus(JSON.parse(ev.data)); } catch { parsed = null; }
            if (parsed) this.ingest(parsed);
        };
        es.onerror = () => {
            this.sseHealthy = false;
            this.invalidateStatusRequests();
            this.maybeStartPolling();
        };
    }

    private closeStream(): void {
        if (this.es) {
            this.es.onopen = null; this.es.onmessage = null; this.es.onerror = null;
            try { this.es.close(); } catch { /* already closed */ }
            this.es = null;
        }
        this.sseHealthy = false;
    }

    private believesRunning(): boolean {
        return this.sawRunning || this.phase === 'requesting' || this.phase === 'running';
    }

    /** Poll only while the stream is down, someone is watching, and a scan is believed running. */
    private maybeStartPolling(): void {
        if (this.disposed || this.polling || this.sseHealthy || this.attached === 0 || !this.believesRunning()) return;
        this.polling = true;
        this.pollFailures = 0;
        const token = ++this.pollToken;
        // The cap is its own timer so a stalled request cannot postpone it.
        this.cancelPollDeadline = this.deps.schedule(() => {
            this.cancelPollDeadline = null;
            if (token === this.pollToken && this.polling) this.giveUpPolling();
        }, this.maxPollMs);
        this.emit();
        void this.pollLoop(token);
    }

    /** Polling budget or deadline spent while a scan was believed running: surface it and unlock rescan. */
    private giveUpPolling(): void {
        if (this.believesRunning()) {
            this.sawRunning = false;
            if (this.phase === 'running' || this.phase === 'requesting') this.phase = 'idle';
            this.notice = { kind: 'disconnected', message: 'Lost contact with the server; the scan status is unknown. You can try again.' };
        }
        this.stopPolling(); // also cancels the in-flight request; emits the final state
    }

    private async pollLoop(token: number): Promise<void> {
        const result = await this.pollOnce();
        if (token !== this.pollToken || !this.polling || this.disposed) return;
        if (result === 'ok') this.pollFailures = 0;
        else if (result === 'failed') this.pollFailures++;

        if (this.pollFailures >= this.maxPollFailures && this.believesRunning()) {
            this.giveUpPolling();
            return;
        }
        if (!this.believesRunning()) { this.stopPolling(); return; }

        this.cancelPollTimer = this.deps.schedule(() => {
            this.cancelPollTimer = null;
            if (token === this.pollToken && this.polling) void this.pollLoop(token);
        }, this.pollIntervalMs);
    }

    /**
     * One status read, owned by the epoch it was issued in. Timeout covers the fetch
     * and the body; ownership is checked BEFORE ingestion, so a late, timed-out or
     * superseded response is dropped ('stale') instead of being published.
     */
    private async pollOnce(): Promise<'ok' | 'failed' | 'stale'> {
        const epoch = this.statusEpoch;
        const controller = typeof AbortController === 'undefined' ? null : new AbortController();
        let rejectTimeout: (e: Error) => void = () => { };
        const timedOut = new Promise<never>((_, reject) => { rejectTimeout = reject; });
        timedOut.catch(() => { });

        const cancelTimer = this.deps.schedule(() => {
            rejectTimeout(new Error('status request timed out'));
            try { controller?.abort(); } catch { /* best effort */ }
        }, this.requestTimeoutMs);
        const req: StatusRequest = {
            cancel: () => { cancelTimer(); try { controller?.abort(); } catch { /* best effort */ } },
        };
        this.inflight.add(req);
        const owned = () => !this.disposed && epoch === this.statusEpoch && this.inflight.has(req);

        try {
            const work = (async () => {
                const res = await this.deps.fetchFn('/api/status', controller ? { signal: controller.signal } : undefined);
                if (!res.ok) return null;
                return parseScanStatus(await res.json());
            })();
            work.catch(() => { }); // a rejection after a timeout is expected and ignored
            const parsed = await Promise.race([work, timedOut]);
            if (!owned()) return 'stale';
            if (!parsed) return 'failed';
            this.ingest(parsed);
            return 'ok';
        } catch {
            return owned() ? 'failed' : 'stale';
        } finally {
            cancelTimer();
            this.inflight.delete(req);
        }
    }

    /** Drop ownership of every outstanding status request and abort it. */
    private invalidateStatusRequests(): void {
        this.statusEpoch++;
        const pending = [...this.inflight];
        this.inflight.clear();
        for (const req of pending) req.cancel();
    }

    private stopPollingIfSettled(): void {
        if (this.polling && !this.believesRunning()) this.stopPolling();
    }

    private stopPolling(): void {
        this.pollToken++;
        this.cancelPollTimer?.();
        this.cancelPollTimer = null;
        this.cancelPollDeadline?.();
        this.cancelPollDeadline = null;
        if (this.polling) {
            this.polling = false;
            this.invalidateStatusRequests();
            this.emit();
        }
    }

    private emit(): void {
        if (!this.disposed) this.deps.onChange(this.state);
    }
}
