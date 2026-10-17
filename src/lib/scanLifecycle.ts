import type { EventEmitter } from 'events';
import { nonThrowingLogger, type ScanErrorCode, type ScanResult } from './scan';

/**
 * Public scan lifecycle: turns the indexer's internal ScanResult into a
 * discriminated, client-safe result, tracks the last terminal outcome and
 * publishes status events. Like scan.ts it has no import-time side effects;
 * db.ts composes it with the production indexer and emitter.
 */

export type ScanOutcome = 'success' | 'partial' | 'failure' | 'busy';
export type ScanFailureReason = ScanErrorCode | 'not_configured';

export interface ScanCounts {
    /** `.info` folders found (0 if the inventory failed). */
    total: number;
    scanned: number;
    upserts: number;
    skipped: number;
    removed: number;
    /** Items whose metadata could not be read; their rows were left unchanged. */
    failedItems: number;
}

/**
 * `error` is a SANITIZED summary (fixed wording, counts only: no paths, ids or
 * raw exception text). Detailed diagnostics go to the server log only.
 */
export type LibraryScanResult =
    | ({ outcome: 'success' } & ScanCounts)
    | ({ outcome: 'partial'; error: string } & ScanCounts)
    | ({ outcome: 'failure'; error: string; reason: ScanFailureReason } & ScanCounts)
    | ({ outcome: 'busy'; error: string } & ScanCounts);

export type StartScanResult =
    /** A scan is now running; `done` always resolves (never rejects) with its terminal result. */
    | { kind: 'accepted'; done: Promise<LibraryScanResult> }
    | { kind: 'busy' }
    | { kind: 'unconfigured'; result: LibraryScanResult };

export interface ScanStatusSnapshot {
    isScanning: boolean;
    scannedCount: number;
    /** 'scanning' while a scan runs, otherwise 'idle'. */
    status: 'scanning' | 'idle';
    /** Terminal outcome of the most recent finished scan in this process (null before the first one). */
    outcome: Exclude<ScanOutcome, 'busy'> | null;
    /** Sanitized summary of that outcome (null on clean success). */
    error: string | null;
    failedItems: number;
    finishedAt: number | null;
}

export const SANITIZED_MESSAGES: Record<ScanFailureReason, string> = {
    not_configured: "The library path is not configured (LIBRARY_PATH).",
    images_unavailable: "The library's images folder is missing or unreadable.",
    library_metadata_invalid: "The library's metadata.json is unreadable or malformed.",
    internal: "The scan failed unexpectedly; see the server log for details.",
};

const BUSY_MESSAGE = "A scan is already in progress.";

const noCounts: ScanCounts = { total: 0, scanned: 0, upserts: 0, skipped: 0, removed: 0, failedItems: 0 };

export function failureResult(reason: ScanFailureReason, counts: Partial<ScanCounts> = {}): LibraryScanResult {
    return { outcome: 'failure', reason, error: SANITIZED_MESSAGES[reason], ...noCounts, ...counts };
}

export function toLibraryScanResult(r: ScanResult): LibraryScanResult {
    const counts: ScanCounts = {
        total: r.total, scanned: r.scanned, upserts: r.upserts, skipped: r.skipped,
        removed: r.removed, failedItems: r.failures.length
    };
    switch (r.status) {
        case 'complete':
            return { outcome: 'success', ...counts };
        case 'partial':
            return {
                outcome: 'partial',
                error: `${counts.failedItems} item(s) had unreadable metadata and were left unchanged; they will be retried on the next scan.`,
                ...counts
            };
        case 'busy':
            return { outcome: 'busy', error: BUSY_MESSAGE, ...counts };
        default:
            return failureResult(r.errorCode ?? 'internal', counts);
    }
}

type Log = { info(...a: any[]): void; error(...a: any[]): void };

/**
 * Emits without ever throwing: a throwing listener must not break a scan (nor
 * starve later listeners of the event), and the reserved 'error' event (which
 * throws when nobody listens) is never used.
 */
export function safeEmit(emitter: EventEmitter, event: string, payload: unknown, log?: Log) {
    if (event === 'error') throw new Error("scan events must not use the reserved 'error' event name");
    // rawListeners keeps once() semantics; each listener is isolated from the others
    for (const listener of emitter.rawListeners(event)) {
        try {
            listener.call(emitter, payload);
        } catch (error) {
            try { log?.error(`[SCAN] Listener for '${event}' threw:`, error); } catch { }
        }
    }
}

/**
 * Runs every named step even when an earlier one (or its reporting) fails.
 * Used by closeResources(); lives here so the guarantee is testable without
 * opening the production database.
 */
export async function runCleanupSteps(steps: [name: string, fn: () => unknown][], log: Pick<Log, 'error'>) {
    const safeLog = nonThrowingLogger(log);
    for (const [name, fn] of steps) {
        try { await fn(); } catch (error) { safeLog.error(`[SHUTDOWN] Failed to close ${name}:`, error); }
    }
}

export interface ScanServiceDeps {
    indexer: { scan(): Promise<ScanResult>; readonly isScanning: boolean; readonly scannedCount: number };
    /** Evaluated per call; empty means the library is not configured. */
    getLibraryPath: () => string;
    emitter: EventEmitter;
    logger?: Log;
}

export function createScanService({ indexer, getLibraryPath, emitter, logger }: ScanServiceDeps) {
    let last: { outcome: ScanStatusSnapshot['outcome']; error: string | null; failedItems: number; finishedAt: number } | null = null;
    // Every report at this seam goes through the nonthrowing adapter (same one the indexer uses)
    const log: Log = nonThrowingLogger(logger ?? { info() { }, error() { } });
    /**
     * Service-level scan ownership: true from the moment a scan is accepted until
     * its terminal result is recorded and published. The indexer releases its own
     * `isScanning` earlier (before its promise resolves), so admission and status
     * must not rely on it alone.
     */
    let owned = false;
    /**
     * Admission-only guard held while a terminal event is delivered to listeners.
     * Unlike `owned` it is NOT part of the reported status: the scan is over, so
     * status reads idle (matching the event payload), but no new scan may be
     * admitted until every synchronous listener has seen the event.
     */
    let publishing = false;

    function getScanStatus(): ScanStatusSnapshot {
        const scanning = owned || indexer.isScanning;
        return {
            isScanning: scanning,
            scannedCount: indexer.scannedCount,
            status: scanning ? 'scanning' : 'idle',
            outcome: last?.outcome ?? null,
            error: last?.error ?? null,
            failedItems: last?.failedItems ?? 0,
            finishedAt: last?.finishedAt ?? null
        };
    }

    /**
     * Records and publishes a terminal result, then ends service ownership. The
     * record and the event are produced in one synchronous step, so the event and
     * an immediately following getScanStatus() agree (both idle). Running status
     * ends first (`owned` cleared) while the admission guard (`publishing`) stays
     * up through all synchronous listener delivery, so a listener that starts a
     * scan gets `busy`. Never throws: a failure of the publication machinery is
     * reported best-effort, the terminal record is kept and both guards are
     * always released.
     */
    function publishTerminal(result: LibraryScanResult, ownsScan = false) {
        if (result.outcome === 'busy') {
            // no record, no event; but an accepted invocation must still release its ownership
            if (ownsScan) owned = false;
            return;
        }
        // Every terminal publication (owned scan or not_configured) holds the admission guard
        publishing = true;
        try {
            last = {
                outcome: result.outcome,
                error: 'error' in result ? result.error : null,
                failedItems: result.failedItems,
                finishedAt: Date.now()
            };
            if (ownsScan) owned = false; // only the scan that owns the flag may clear it
            safeEmit(emitter, 'complete', { ...getScanStatus(), total: result.total }, log);
        } catch (error) {
            log.error("[SCAN] Terminal publication failed:", error);
        } finally {
            if (ownsScan) owned = false;
            publishing = false;
        }
    }

    async function run(): Promise<LibraryScanResult> {
        let result: LibraryScanResult = failureResult('internal');
        try {
            result = toLibraryScanResult(await indexer.scan());
            if (result.outcome === 'failure') log.error(`[SCAN] Scan failed (${result.reason}).`);
        } catch (error) {
            log.error("[SCAN] Scan threw unexpectedly:", error);
        } finally {
            publishTerminal(result, true);
        }
        return result;
    }

    function startLibraryScan(): StartScanResult {
        // Admission boundary (checked before configuration, so an unconfigured call cannot re-enter
        // a terminal publication): the service still owns the previous scan until its event is out.
        if (owned || publishing || indexer.isScanning) return { kind: 'busy' };
        if (!getLibraryPath()) {
            const result = failureResult('not_configured');
            publishTerminal(result); // publish first; reporting is best-effort and cannot prevent it
            log.error("[SCAN] Cannot scan: LIBRARY_PATH is not configured.");
            return { kind: 'unconfigured', result };
        }
        owned = true; // claimed synchronously, so two callers can never both get past the check
        return { kind: 'accepted', done: run() };
    }

    async function performLibraryScan(): Promise<LibraryScanResult> {
        const started = startLibraryScan();
        switch (started.kind) {
            case 'accepted': return started.done;
            case 'unconfigured': return started.result;
            default: return { outcome: 'busy', error: BUSY_MESSAGE, ...noCounts };
        }
    }

    return { getScanStatus, startLibraryScan, performLibraryScan, safeEmit: (event: string, payload: unknown) => safeEmit(emitter, event, payload, log) };
}

// ---- POST /api/scan ---------------------------------------------------------

const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Response contract:
 *  - 200 `{ message: "Scan started", status: "accepted" }`: a scan is running now.
 *  - 409 `{ message, status: "busy" }`: a scan was already running; nothing new started.
 *  - 503 `{ error, status: "unavailable" }`: no library configured (generic text only).
 *  - 500 `{ error }`: unexpected failure while starting (generic text only).
 */
export function createScanHandler(start: () => StartScanResult, rawLog: Log = console) {
    const log = nonThrowingLogger(rawLog);
    return async (): Promise<Response> => {
        try {
            log.info("[API] Manual scan requested");
            const started = start();
            switch (started.kind) {
                case 'accepted':
                    // fire-and-forget: a (contract-violating) rejection must not become an unhandled rejection
                    started.done.then(undefined, (error) => log.error("[API] Scan promise rejected:", error));
                    return json({ message: "Scan started", status: 'accepted' }, 200);
                case 'busy':
                    return json({ message: BUSY_MESSAGE, status: 'busy' }, 409);
                case 'unconfigured':
                    return json({ error: SANITIZED_MESSAGES.not_configured, status: 'unavailable' }, 503);
            }
        } catch (error) {
            log.error("[API] Failed to start scan:", error);
            return json({ error: "Failed to start the scan." }, 500);
        }
    };
}

// ---- CLI --------------------------------------------------------------------

/** Process exit codes for setup / update / rebuild. */
export const EXIT_CODES = {
    SUCCESS: 0,
    /** The scan (or its preparation) failed; nothing trustworthy was indexed. */
    FAILURE: 1,
    /** The scan finished but some items were unreadable (rows left unchanged, retried next scan). */
    PARTIAL: 2,
} as const;

export function exitCodeForResult(result: LibraryScanResult): number {
    switch (result.outcome) {
        case 'success': return EXIT_CODES.SUCCESS;
        case 'partial': return EXIT_CODES.PARTIAL;
        default: return EXIT_CODES.FAILURE; // failure and busy
    }
}

export interface ScanCommandOptions {
    /** Tag used in output, e.g. "SETUP". */
    label: string;
    scan: () => Promise<LibraryScanResult>;
    emitter: EventEmitter;
    /** Runs before the scan inside the guarded block (e.g. initDB). */
    prepare?: () => void;
    /** Always runs last: close watcher, DB, ExifTool. Must not be needed for correctness of the exit code. */
    cleanup: () => Promise<void>;
    out?: (line: string) => void;
    err?: (line: string) => void;
    progress?: (text: string) => void;
}

/** Awaits the scan result (never an event), prints one terminal line and returns the exit code. */
export async function runScanCommand(opts: ScanCommandOptions): Promise<number> {
    // Reporting is best-effort: a throwing writer (e.g. a closed pipe) must not change the exit code or skip cleanup
    const bestEffort = (fn: (s: string) => void) => (s: string) => { try { fn(s); } catch { } };
    const out = bestEffort(opts.out ?? ((l: string) => console.log(l)));
    const err = bestEffort(opts.err ?? ((l: string) => console.error(l)));
    const progress = bestEffort(opts.progress ?? ((t: string) => { process.stdout.write(t); }));
    const tag = `[${opts.label}]`;
    const onProgress = (data: any) => progress(`\r${tag} Scanning: ${data.scannedCount}/${data.total}`);
    opts.emitter.on('progress', onProgress);

    let code: number = EXIT_CODES.FAILURE;
    try {
        opts.prepare?.();
        const result = await opts.scan();
        code = exitCodeForResult(result);
        const counts = `${result.total} item folder(s); ${result.upserts} updated, ${result.skipped} unchanged, ${result.removed} removed, ${result.failedItems} unreadable`;
        out("");
        if (result.outcome === 'success') out(`${tag} Result: success (${counts}).`);
        else if (result.outcome === 'partial') err(`${tag} Result: PARTIAL (${counts}). ${result.error}`);
        else err(`${tag} Result: FAILED. ${result.error}`);
    } catch (error) {
        err(`\n${tag} Result: FAILED. Unexpected error:`);
        err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    } finally {
        opts.emitter.removeListener('progress', onProgress);
        try {
            await opts.cleanup();
        } catch (error) {
            err(`${tag} Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return code;
}

export interface ThumbnailCommandOptions {
    /** Empty means the library is not configured. */
    libraryPath: string;
    /** Enumerates items; a throw is a fatal failure (never "zero items"). */
    listItems: () => { id: string }[];
    /** A throw counts as an item error; a falsy result (unsupported type, nothing to generate) is a legitimate skip. */
    generate: (id: string) => Promise<unknown>;
    /** Always runs last: close watcher, DB, ExifTool. */
    cleanup: () => Promise<void>;
    concurrency?: number;
    log?: Log;
}

/**
 * Exit codes: 0 every item was generated or legitimately skipped (including an
 * empty library); 1 not configured, enumeration failed or an unexpected error;
 * 2 the run completed but at least one item raised an error.
 */
export async function runThumbnailCommand(opts: ThumbnailCommandOptions): Promise<number> {
    const log = nonThrowingLogger(opts.log ?? console);
    const concurrency = opts.concurrency ?? 10;
    let code: number = EXIT_CODES.FAILURE;
    try {
        log.info("Starting bulk thumbnail generation...");
        if (!opts.libraryPath) {
            log.error("Cannot generate thumbnails: LIBRARY_PATH is not configured.");
            return code;
        }

        let items: { id: string }[];
        try {
            items = opts.listItems();
        } catch (error) {
            log.error("Failed to fetch items:", error);
            return code;
        }
        log.info(`Found ${items.length} items.`);

        let generated = 0, skipped = 0, errors = 0;
        for (let i = 0; i < items.length; i += concurrency) {
            await Promise.all(items.slice(i, i + concurrency).map(async (item) => {
                try {
                    if (await opts.generate(item.id)) generated++;
                    else skipped++;
                } catch (error) {
                    log.error(`Failed ${item.id}:`, error);
                    errors++;
                }
            }));
        }

        log.info(`Done! Processed: ${items.length}. Generated: ${generated}. Skipped: ${skipped}. Errors: ${errors}.`);
        code = errors > 0 ? EXIT_CODES.PARTIAL : EXIT_CODES.SUCCESS;
    } catch (error) {
        log.error("Fatal error:", error);
        code = EXIT_CODES.FAILURE;
    } finally {
        try {
            await opts.cleanup();
        } catch (error) {
            log.error("Cleanup failed:", error);
        }
    }
    return code;
}

/**
 * Sets the exit code and lets the process end naturally. This runs AFTER the
 * awaited cleanup: if a handle is still leaked at that point, an unref'd timer
 * forces the exit after `graceMs`. It cannot rescue cleanup that never resolves
 * (we never get here), and it does not wait for stdout/stderr to drain.
 */
export function finishCli(code: number, graceMs = 2000) {
    process.exitCode = code;
    setTimeout(() => process.exit(code), graceMs).unref();
}
