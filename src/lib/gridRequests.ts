import type { FilterState } from '../stores/libraryStore';
import {
    DEFAULT_CUSTOM_RATIO, MAX_TYPE_FACETS, MAX_TYPE_KEY_LENGTH, SHAPE_KEYS, type ShapeKey,
} from './itemFacets';

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
    /** Page 1 only; null = absent or invalid (unavailable), {} is a valid empty map. */
    shapeCounts: Record<ShapeKey, number> | null;
    typeCounts: Record<string, number> | null;
}

/** Facet publication: a present key replaces that store; null = unavailable. */
export interface FacetUpdate {
    shape?: Record<ShapeKey, number> | null;
    type?: Record<string, number> | null;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/** Own-key map with exactly the fixed shape keys and finite nonnegative integer values; else null. */
export function parseShapeCounts(raw: unknown): Record<ShapeKey, number> | null {
    if (!isPlainObject(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length !== SHAPE_KEYS.length) return null;
    const out = {} as Record<ShapeKey, number>;
    for (const key of SHAPE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) return null;
        const v = raw[key];
        if (!isCount(v)) return null;
        out[key] = v;
    }
    return out;
}

/** Bounded own-key map of extension key -> finite nonnegative integer; else null. */
export function parseTypeCounts(raw: unknown): Record<string, number> | null {
    if (!isPlainObject(raw)) return null;
    const entries = Object.entries(raw);
    if (entries.length > MAX_TYPE_FACETS) return null;
    for (const [key, v] of entries) {
        if (key.length > MAX_TYPE_KEY_LENGTH || !isCount(v)) return null;
    }
    return Object.fromEntries(entries) as Record<string, number>;
}

/**
 * Stable identity of what each facet's counts depend on. A shape count context
 * is everything except the shape selection (the committed custom ratio IS part
 * of it); a type count context is everything except the type selection. Sort is
 * irrelevant. `scope` carries request-level context (unlock set, readiness).
 */
export function facetContextKeys(filters: FilterState, scope: string = ''): { shape: string; type: string } {
    const common = [
        filters.search, filters.folderId, filters.specialFilter, filters.recursive, filters.color,
        filters.colorAccuracy, filters.tagRule, filters.includedTags, filters.excludedTags, scope,
    ];
    return {
        shape: JSON.stringify([...common, filters.includedTypes, filters.excludedTypes, filters.customRatio]),
        type: JSON.stringify([...common, filters.includedShapes, filters.excludedShapes, filters.customRatio]),
    };
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

    // Shape/type facets: repeated params (no delimiter ambiguity). The committed
    // custom pair is always sent so the Custom count exists before it is selected.
    (filters.includedShapes ?? []).forEach(s => params.append('shape', s));
    (filters.excludedShapes ?? []).forEach(s => params.append('excludedShape', s));
    (filters.includedTypes ?? []).forEach(t => params.append('type', t));
    (filters.excludedTypes ?? []).forEach(t => params.append('excludedType', t));
    const ratio = filters.customRatio ?? DEFAULT_CUSTOM_RATIO;
    params.append('ratioWidth', String(ratio.width));
    params.append('ratioHeight', String(ratio.height));

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
    return {
        items: d.items as T[], totalItems: d.totalItems, relevantTags: tags, relevantTagCounts: counts,
        shapeCounts: parseShapeCounts(d.shapeCounts), typeCounts: parseTypeCounts(d.typeCounts),
    };
}

/**
 * Whether another page can exist after a successful response. A short (or
 * empty) page always ends the list, so a stale or too-high reported total can
 * never cause endless paging. A valid nonnegative integer total additionally
 * ends the list as soon as everything is loaded, which avoids a final empty
 * request when the count is an exact multiple of the page size.
 */
export function hasMoreAfterPage(loaded: number, pageLength: number, pageSize: number, totalItems: unknown): boolean {
    if (pageLength < pageSize) return false;
    if (typeof totalItems === 'number' && Number.isInteger(totalItems) && totalItems >= 0 && loaded >= totalItems) return false;
    return true;
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
    /**
     * Shape/type facet counts. Fired for current-generation page-1 results only
     * (null = absent/invalid, i.e. unavailable) and with both null when a
     * refresh is disabled (e.g. a locked-folder screen).
     */
    onFacets?: (update: FacetUpdate) => void;
    /**
     * Called after a current-generation request has fully settled (success OR
     * failure) and the single-flight slot is free again. Unlike onChange, which
     * fires while the request is still marked in flight, loadMore() called from
     * here starts a new request instead of being dropped.
     */
    onSettled?: (state: GridState<T>) => void;
}

export class GridRequestController<T extends { id: string }> {
    private readonly fetchFn: GridFetch;
    private readonly pageSize: number;
    private readonly onChange: (state: GridState<T>) => void;
    private readonly onContextTags?: (tags: string[], counts: Record<string, number> | null) => void;
    private readonly onSettled?: (state: GridState<T>) => void;
    private readonly onFacets?: (update: FacetUpdate) => void;

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
        this.onSettled = opts.onSettled;
        this.onFacets = opts.onFacets;
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
        else this.onFacets?.({ shape: null, type: null });
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
            if (page === 1) {
                this.onFacets?.({ shape: parsed.shapeCounts, type: parsed.typeCounts });
            }
            const nextItems = page === 1 ? parsed.items : [...this._state.items, ...parsed.items];
            this.set({
                items: nextItems,
                totalItems: parsed.totalItems,
                hasMore: hasMoreAfterPage(nextItems.length, parsed.items.length, this.pageSize, parsed.totalItems),
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
            if (isCurrent()) {
                this.inFlight = false;
                this.onSettled?.(this._state);
            }
        }
    }
}
