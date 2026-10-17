import path from 'path';
import { itemIdFromDirName, type LibraryRefreshOutcome, type Logger, type MutationOutcome } from './scan';

/**
 * Routes raw filesystem events from the library watcher to index / cache /
 * lock-snapshot actions, with per-target debouncing and bounded retry of
 * partial writes. Free of import-time side effects; timers and the indexer are
 * injected so tests run it deterministically.
 *
 * | event                                         | action (after debounce)                              |
 * |-----------------------------------------------|------------------------------------------------------|
 * | <lib>/metadata.json add/change                | refreshLibraryMetadata (locks/tags snapshot); retry  |
 * | images/<id>.info/metadata.json add/change     | itemChanged (re-index + invalidate cache); retry     |
 * | images/<id>.info/<other file> add/change/unlink | invalidateCache(id) (original/thumbnail changed)   |
 * | images/<id>.info directory removed            | itemRemoved immediately (pending timers cancelled)   |
 *
 * Retry never marks anything permanently failed: an unreadable item stays
 * flagged for the next scan by the indexer itself (last_scanned = 0).
 */

export interface WatcherIndexer {
    itemChanged(id: string): Promise<MutationOutcome>;
    itemRemoved(id: string): Promise<MutationOutcome>;
    refreshLibraryMetadata(): Promise<LibraryRefreshOutcome>;
}

export interface WatcherTimers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface WatcherRouterDeps {
    libraryPath: string;
    indexer: WatcherIndexer;
    invalidateCache: (id: string) => void;
    logger?: Partial<Logger>;
    timers?: WatcherTimers;
    /** Quiet period collapsing bursts of events for the same target. */
    debounceMs?: number;
    /** Delays before successive retries of an unreadable (partially written) file. */
    retryDelaysMs?: number[];
}

export type WatcherEventKind = 'add' | 'change' | 'unlink';

export const DEFAULT_DEBOUNCE_MS = 500;
export const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

type Target =
    | { type: 'root' }
    | { type: 'itemMeta'; id: string }
    | { type: 'itemMedia'; id: string };

export function createWatcherRouter(deps: WatcherRouterDeps) {
    const timers: WatcherTimers = deps.timers ?? {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    };
    const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const log = {
        error: (...a: any[]) => { try { deps.logger?.error?.(...a); } catch { } },
        verbose: (...a: any[]) => { try { deps.logger?.verbose?.(...a); } catch { } }
    };
    const libraryRoot = path.resolve(deps.libraryPath);
    const timerByKey = new Map<string, unknown>();
    let disposed = false;

    function classify(filePath: string): Target | null {
        const rel = path.relative(libraryRoot, path.resolve(filePath));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        const parts = rel.split(path.sep);
        if (parts.length === 1) return parts[0] === 'metadata.json' ? { type: 'root' } : null;
        if (parts[0] !== 'images' || parts.length < 3) return null;
        const id = itemIdFromDirName(parts[1]);
        if (!id) return null;
        if (parts.length === 3 && parts[2] === 'metadata.json') return { type: 'itemMeta', id };
        return { type: 'itemMedia', id };
    }

    function schedule(key: string, delay: number, fn: () => void) {
        const previous = timerByKey.get(key);
        if (previous !== undefined) timers.clearTimeout(previous);
        const handle = timers.setTimeout(() => {
            if (timerByKey.get(key) === handle) timerByKey.delete(key);
            if (!disposed) fn();
        }, delay);
        timerByKey.set(key, handle);
    }

    /**
     * Attempt ownership: each retry-capable target key has at most one current owner
     * token. A new event (or a directory removal) replaces/clears it, which makes every
     * continuation of an earlier, possibly still in-flight, attempt stale: a stale
     * attempt may finish but can never schedule a retry (and so can never cancel the
     * newer event's timer or resurrect work after a removal).
     */
    const owners = new Map<string, number>();
    let nextToken = 0;
    function claim(key: string): number {
        const token = ++nextToken;
        owners.set(key, token);
        return token;
    }
    function release(key: string) {
        owners.delete(key);
    }

    /** Runs `attemptFn`; on a retryable outcome the current owner schedules the next attempt under the same key. */
    function runWithRetry(key: string, token: number, what: string, attemptFn: () => Promise<string>, attempt = 0) {
        void (async () => {
            let outcome: string;
            try {
                outcome = await attemptFn();
            } catch (error) {
                log.error(`[WATCHER] ${what} failed:`, error);
                outcome = 'failed';
            }
            if (disposed || owners.get(key) !== token) return; // superseded, removed, or disposed
            const retryable = outcome === 'unreadable' || outcome === 'rejected';
            if (retryable && attempt < retryDelays.length) {
                schedule(key, retryDelays[attempt], () => runWithRetry(key, token, what, attemptFn, attempt + 1));
                return;
            }
            release(key);
            if (retryable) {
                log.error(`[WATCHER] ${what} still unreadable after ${attempt + 1} attempts; it will be retried by the next scan.`);
            }
        })();
    }

    /** Debounces a retry-capable action; the event itself takes ownership immediately. */
    function scheduleWithRetry(key: string, what: string, attemptFn: () => Promise<string>) {
        const token = claim(key);
        schedule(key, debounceMs, () => runWithRetry(key, token, what, attemptFn));
    }

    function onFileEvent(filePath: string, _kind: WatcherEventKind = 'change') {
        if (disposed) return;
        const target = classify(filePath);
        if (!target) return;

        if (target.type === 'root') {
            if (_kind === 'unlink') return; // keep the previous snapshot; never "ready, nothing locked"
            scheduleWithRetry('root', 'Library metadata reload', () => deps.indexer.refreshLibraryMetadata());
        } else if (target.type === 'itemMeta') {
            if (_kind === 'unlink') return; // directory removal is handled by onDirRemoved
            const { id } = target;
            scheduleWithRetry(`meta:${id}`, `Item ${id} reindex`, () => deps.indexer.itemChanged(id));
        } else {
            const { id } = target;
            schedule(`media:${id}`, debounceMs, () => {
                try { deps.invalidateCache(id); } catch (error) { log.error(`[WATCHER] Cache invalidation failed for ${id}:`, error); }
            });
        }
    }

    function onDirRemoved(dirPath: string) {
        if (disposed) return;
        const rel = path.relative(libraryRoot, path.resolve(dirPath));
        const parts = rel.split(path.sep);
        if (parts.length !== 2 || parts[0] !== 'images') return;
        const id = itemIdFromDirName(parts[1]);
        if (!id) return;
        for (const key of [`meta:${id}`, `media:${id}`]) {
            const h = timerByKey.get(key);
            if (h !== undefined) { timers.clearTimeout(h); timerByKey.delete(key); }
            release(key); // an attempt still in flight for this item must not schedule anything
        }
        void deps.indexer.itemRemoved(id).catch((error) => log.error(`[WATCHER] Removing ${id} failed:`, error));
    }

    function dispose() {
        disposed = true;
        for (const h of timerByKey.values()) timers.clearTimeout(h);
        timerByKey.clear();
        owners.clear();
    }

    return { onFileEvent, onDirRemoved, dispose, get pending() { return timerByKey.size; } };
}
