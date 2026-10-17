import type { FilterState } from '../stores/libraryStore';

/**
 * Request ownership + pagination state machine for the image grid, kept free of
 * React so it can be tested with injected fetch and deferred promises.
 *
 * Ownership: every refresh (filter / unlock / readiness change) bumps a
 * generation and aborts the previous generation's AbortController. A response
 * may only touch state if the generation it started under is still current, so
 * an older response resolving last can never overwrite newer results.
 *
 * Pagination: `page` is the NEXT page to fetch and only advances after a
 * successful, validated response. At most one request is in flight (tracked by
 * the controller, not by render state). A failure leaves page/hasMore/items
 * untouched and records a retryable error; infinite scroll does not auto-retry
 * while an error is pending.
 */

export const GRID_PAGE_SIZE = 50;

export type GridErrorKind = 'http' | 'network' | 'payload';

export interface GridError {
    kind: GridErrorKind;
    status?: number;
    message: string;
    /** Page that failed (the one a retry will request again). */
    page: number;
}

export interface GridState<T> {
    items: T[];
    loading: boolean;
    error: GridError | null;
    hasMore: boolean;
    /** Next page to fetch. */
    page: number;
    totalItems: number | null;
    generation: number;
    /** False for views that must not fetch (e.g. a locked-folder screen). */
    enabled: boolean;
}

export interface ItemsPage<T> {
    items: T[];
    totalItems: number;
    /** Present on page 1 only; [] / {} are valid "degraded" values. */
    relevantTags: string[] | null;
    relevantTagCounts: Record<string, number> | null;
}

export type GridFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export function buildItemsUrl(filters: FilterState, page: number, limit: number = GRID_PAGE_SIZE): string {
    const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
        sortBy: filters.sortBy || 'modificationTime',
        sortOrder: filters.sortOrder || 'desc',
        ...(filters.search && { search: filters.search }),
        ...(filters.folderId && { folderId: filters.folderId }),
        ...(filters.specialFilter && { specialFilter: filters.specialFilter }),
        ...(filters.color && { color: filters.color }),
        ...(filters.colorAccuracy !== undefined && { colorAccuracy: filters.colorAccuracy.toString() }),
        recursive: filters.recursive ? 'true' : 'false',
    });

    if (filters.includedTags && filters.includedTags.length) {
        params.append('tag', filters.includedTags.join(','));
        if (filters.tagRule === 'any') params.append('tagRule', 'any');
    }
    if (filters.excludedTags && filters.excludedTags.length) params.append('excludedTags', filters.excludedTags.join(','));

    return `/api/items?${params.toString()}`;
}

class GridPayloadError extends Error { }

/** Validate an /api/items payload; throws GridPayloadError on a bad shape. */
export function parseItemsPayload<T>(data: unknown): ItemsPage<T> {
    if (!data || typeof data !== 'object') throw new GridPayloadError('Response is not an object');
    const d = data as Record<string, unknown>;
    if (!Array.isArray(d.items)) throw new GridPayloadError('Response is missing an items array');
    if (typeof d.totalItems !== 'number' || !Number.isFinite(d.totalItems)) {
        throw new GridPayloadError('Response has an invalid totalItems');
    }
    const tags = Array.isArray(d.relevantTags) ? (d.relevantTags as unknown[]).filter((t): t is string => typeof t === 'string') : null;
    const counts = d.relevantTagCounts && typeof d.relevantTagCounts === 'object' && !Array.isArray(d.relevantTagCounts)
        ? d.relevantTagCounts as Record<string, number>
        : null;
    return { items: d.items as T[], totalItems: d.totalItems, relevantTags: tags, relevantTagCounts: counts };
}

/** Index of the selected item within the current results, or null if it is gone. */
export function resolveSelection<T extends { id: string }>(items: T[], selectedId: string | null): number | null {
    if (selectedId === null) return null;
    const index = items.findIndex(i => i.id === selectedId);
    return index === -1 ? null : index;
}

export interface GridControllerOptions<T> {
    fetchFn: GridFetch;
    pageSize?: number;
    onChange: (state: GridState<T>) => void;
    /** Called for current-generation page-1 responses carrying contextual tags. */
    onContextTags?: (tags: string[], counts: Record<string, number> | null) => void;
}

export class GridRequestController<T extends { id: string }> {
    private readonly fetchFn: GridFetch;
    private readonly pageSize: number;
    private readonly onChange: (state: GridState<T>) => void;
    private readonly onContextTags?: (tags: string[], counts: Record<string, number> | null) => void;

    private filters: FilterState | null = null;
    private abortController = new AbortController();
    private inFlight = false;
    private disposed = false;
    private _state: GridState<T> = {
        items: [], loading: false, error: null, hasMore: true, page: 1, totalItems: null, generation: 0, enabled: true,
    };

    constructor(opts: GridControllerOptions<T>) {
        this.fetchFn = opts.fetchFn;
        this.pageSize = opts.pageSize ?? GRID_PAGE_SIZE;
        this.onChange = opts.onChange;
        this.onContextTags = opts.onContextTags;
    }

    get state(): GridState<T> { return this._state; }
    get generation(): number { return this._state.generation; }

    /**
     * New request context (filters / lock state / readiness changed): bump the
     * generation, abort whatever is in flight, reset pagination and (when
     * enabled) fetch page 1 with the given filters.
     */
    refresh(filters: FilterState, enabled: boolean = true): void {
        if (this.disposed) return;
        this.abortController.abort();
        this.abortController = new AbortController();
        this.inFlight = false;
        this.filters = filters;
        this.set({
            items: [], loading: false, error: null, hasMore: true, page: 1, totalItems: null,
            generation: this._state.generation + 1, enabled,
        });
        if (enabled) void this.load();
    }

    /**
     * Data changed on the server (e.g. a rescan finished): start a new
     * generation with the SAME filters and enabled state, so the user's view
     * is kept while page 1 is refetched. No-op before the first refresh().
     */
    reload(): void {
        if (!this.filters) return;
        this.refresh(this.filters, this._state.enabled);
    }

    /** Infinite-scroll trigger: no-op while loading, errored, exhausted or disabled. */
    loadMore(): void {
        if (this._state.error) return;
        void this.load();
    }

    /** Explicit user retry of the failed page; items and pagination are kept. */
    retry(): void {
        if (!this._state.error || this.inFlight) return;
        this.set({ error: null });
        void this.load();
    }

    dispose(): void {
        this.disposed = true;
        this.abortController.abort();
    }

    private set(patch: Partial<GridState<T>>): void {
        this._state = { ...this._state, ...patch };
        if (!this.disposed) this.onChange(this._state);
    }

    private async load(): Promise<void> {
        const s = this._state;
        if (this.disposed || !this.filters || !s.enabled || !s.hasMore || this.inFlight) return;

        const gen = s.generation;
        const page = s.page;
        const { signal } = this.abortController;
        const isCurrent = () => !this.disposed && gen === this._state.generation;

        this.inFlight = true;
        this.set({ loading: true, error: null });

        try {
            const res = await this.fetchFn(buildItemsUrl(this.filters, page, this.pageSize), { signal });
            if (!isCurrent()) return;
            if (!res.ok) {
                throw Object.assign(new Error(res.status === 503 ? 'The library is not ready yet' : `Request failed (HTTP ${res.status})`), { gridKind: 'http', status: res.status });
            }

            let body: unknown;
            try {
                body = await res.json();
            } catch {
                if (!isCurrent()) return;
                throw new GridPayloadError('Response was not valid JSON');
            }
            if (!isCurrent()) return;

            const parsed = parseItemsPayload<T>(body);

            if (page === 1 && parsed.relevantTags) {
                this.onContextTags?.(parsed.relevantTags, parsed.relevantTagCounts);
            }
            this.set({
                items: page === 1 ? parsed.items : [...this._state.items, ...parsed.items],
                totalItems: parsed.totalItems,
                hasMore: parsed.items.length >= this.pageSize,
                page: page + 1,
                loading: false,
                error: null,
            });
        } catch (err) {
            if (!isCurrent()) return;
            const e = err as { gridKind?: GridErrorKind; status?: number; message?: string };
            const kind: GridErrorKind = e.gridKind ?? (err instanceof GridPayloadError ? 'payload' : 'network');
            this.set({
                loading: false,
                error: {
                    kind,
                    status: e.status,
                    message: kind === 'network' ? 'Network error while loading items' : (e.message || 'Failed to load items'),
                    page,
                },
            });
        } finally {
            if (isCurrent()) this.inFlight = false;
        }
    }
}
