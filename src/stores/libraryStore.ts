import { atom, map } from 'nanostores';
import { DEFAULT_THEME, THEME_STORAGE_KEY, type Theme } from '../lib/theme';
import { getBrowserStorage, readSavedPreferences } from '../lib/preferences';
import { ScanClient, type ScanUiState } from '../lib/scanClient';
import { DEFAULT_CUSTOM_RATIO, cycleInclude, toggleExclude, type CustomRatio, type ShapeKey } from '../lib/itemFacets';

export interface Folder {
    id: string;
    name: string;
    description: string;
    children: Folder[];
    hasPassword?: boolean;
    passwordTips?: string;
    iconColor?: string;
}

export interface TagGroup {
    id: string;
    name: string;
    tags: string[];
    color?: string;
}

export type SortBy = 'modificationTime' | 'btime' | 'name' | 'ext' | 'size' | 'dimensions' | 'star' | 'duration';
export type SortOrder = 'asc' | 'desc';
export type LayoutMode = 'masonry' | 'justified' | 'grid';

export interface FilterState {
    search: string;
    folderId: string | null;
    includedTags: string[];
    excludedTags: string[];
    tagRule: 'all' | 'any';
    color: string | null;
    colorAccuracy: number;
    sortBy: SortBy;
    sortOrder: SortOrder;
    specialFilter: 'uncategorized' | 'untagged' | 'random' | 'trash' | null;
    recursive: boolean;
    includedShapes: ShapeKey[];
    excludedShapes: ShapeKey[];
    /** Committed custom ratio (always sent so the Custom count exists before selection). */
    customRatio: CustomRatio;
    /** Lowercase extension keys, no dot; '' = no extension. */
    includedTypes: string[];
    excludedTypes: string[];
}

// State Atoms
export const foldersStore = atom<Folder[]>([]);
export const tagsStore = atom<string[]>([]);
export const tagCountsStore = atom<Record<string, number>>({});
// Tags present in the current view context (folder/special filter); null = no context yet
export const relevantTagsStore = atom<string[] | null>(null);
export const relevantTagCountsStore = atom<Record<string, number> | null>(null);
export const tagsGroupsStore = atom<TagGroup[]>([]);
export const lockedFoldersStore = atom<Set<string>>(new Set());
export const unlockedFoldersStore = atom<Set<string>>(new Set()); // Session unlocks (matches server cookie)
// Server lock metadata readiness (/api/meta `ready`); null = not reported yet.
// The grid refreshes when this changes, since /api/items answers 503 until ready.
export const libraryReadyStore = atom<boolean | null>(null);
// Bumped when server data changed under the current view (e.g. a rescan finished);
// the grid reloads page 1 through its controller without touching filters.
export const gridRevisionStore = atom<number>(0);
export const bumpGridRevision = () => gridRevisionStore.set(gridRevisionStore.get() + 1);
export const layoutStore = atom<LayoutMode>('masonry');
export const sidebarOpenStore = atom<boolean>(false);
export const themeStore = atom<Theme>(DEFAULT_THEME);
export const zoomLevelStore = atom<number>(200); // Pixels, e.g. 50 to 350
export const recentColorsStore = atom<string[]>([]); // Array of hex codes

// Filter Map
export const filtersStore = map<FilterState>({
    search: '',
    folderId: null,
    includedTags: [],
    excludedTags: [],
    tagRule: 'all',
    color: null,
    colorAccuracy: 60, // Default threshold
    sortBy: 'modificationTime',
    sortOrder: 'desc',
    specialFilter: null,
    recursive: false,
    includedShapes: [],
    excludedShapes: [],
    customRatio: DEFAULT_CUSTOM_RATIO,
    includedTypes: [],
    excludedTypes: []
});

// Facet counts for the current view context; null = unavailable (loading,
// failed, or a view that does not fetch) — never the previous context's counts.
export const shapeCountsStore = atom<Record<ShapeKey, number> | null>(null);
export const typeCountsStore = atom<Record<string, number> | null>(null);

// Actions
export const setSidebarOpen = (open: boolean) => sidebarOpenStore.set(open);
export const toggleSidebar = () => sidebarOpenStore.set(!sidebarOpenStore.get());
export const setZoom = (zoom: number) => {
    zoomLevelStore.set(zoom);
    try { localStorage.setItem('library_zoom', zoom.toString()); } catch { /* storage blocked: session-only */ }
};

export const toggleTheme = () => {
    const newTheme = themeStore.get() === 'light' ? 'dark' : 'light';
    themeStore.set(newTheme);
    try {
        localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    } catch (e) { /* storage blocked: toggle still applies for this session */ }
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
};


// Actions
export async function fetchMetadata() {
    try {
        const res = await fetch('/api/meta');
        const data = await res.json();
        if (typeof data.ready === 'boolean' && data.ready !== libraryReadyStore.get()) {
            libraryReadyStore.set(data.ready);
        }
        foldersStore.set(data.folders || []);
        tagsStore.set(data.tags || []);
        tagCountsStore.set(data.tagCounts || {});
        tagsGroupsStore.set(data.tagsGroups || []);
        lockedFoldersStore.set(new Set(data.lockedFolderIds || []));
        // Only replace the set when membership actually changed, so listeners
        // (e.g. the grid's refetch effect) don't fire for an identical set
        const nextUnlocked = new Set<string>(data.unlockedFolderIds || []);
        const currUnlocked = unlockedFoldersStore.get();
        if (nextUnlocked.size !== currUnlocked.size || [...nextUnlocked].some(id => !currUnlocked.has(id))) {
            unlockedFoldersStore.set(nextUnlocked);
        }
    } catch (err) {
        console.error('Failed to fetch metadata:', err);
    }
}

// Rescan: one shared client (event stream + status polling + cooldown) for every
// component that shows or triggers scans.
export const scanStateStore = atom<ScanUiState>({
    phase: 'idle', scannedCount: 0, totalItems: null, notice: null,
    cooldownSeconds: 0, polling: false, canStart: true,
});

let scanClient: ScanClient | null = null;
function getScanClient(): ScanClient {
    if (!scanClient) {
        scanClient = new ScanClient({
            fetchFn: (url, init) => fetch(url, init),
            createEventSource: url => (typeof EventSource === 'undefined' ? null : new EventSource(url)),
            schedule: (fn, ms) => {
                const id = setTimeout(fn, ms);
                return () => clearTimeout(id);
            },
            now: () => Date.now(),
            // Metadata first so lock state is fresh before the grid reloads.
            onScanComplete: async () => {
                await fetchMetadata();
                bumpGridRevision();
            },
            onChange: state => scanStateStore.set(state),
        });
    }
    return scanClient;
}

/** Mount-time subscription; returns the detach function (closes stream/polling when last). */
export const attachScanMonitor = (): (() => void) => getScanClient().attach();
export const startLibraryRescan = (): Promise<void> => getScanClient().start();
export const dismissScanNotice = (): void => getScanClient().dismissNotice();

export function setSearch(search: string) {
    filtersStore.setKey('search', search);
}

export function setFolderId(folderId: string | null) {
    filtersStore.setKey('folderId', folderId);
}

export function setSortBy(sortBy: SortBy) {
    filtersStore.setKey('sortBy', sortBy);
}

export function setSortOrder(sortOrder: SortOrder) {
    filtersStore.setKey('sortOrder', sortOrder);
}

export function setLayout(layout: LayoutMode) {
    layoutStore.set(layout);
    try { localStorage.setItem('library_layout', layout); } catch { /* storage blocked: session-only */ }
}

export function toggleTag(tag: string) {
    const { includedTags, excludedTags } = filtersStore.get();

    // Check if tag is in included
    if (includedTags.includes(tag)) {
        // Remove from included (Positive -> Neutral)
        filtersStore.setKey('includedTags', includedTags.filter(t => t !== tag));
    } else if (excludedTags.includes(tag)) {
        // Remove from excluded (Negative -> Neutral)
        filtersStore.setKey('excludedTags', excludedTags.filter(t => t !== tag));
    } else {
        // Add to included (Neutral -> Positive)
        filtersStore.setKey('includedTags', [...includedTags, tag]);
    }
}

export function toggleTagExclude(tag: string) {
    // Right click or long press behavior: Toggle Exclude
    const { includedTags, excludedTags } = filtersStore.get();

    if (excludedTags.includes(tag)) {
        // Remove from excluded
        filtersStore.setKey('excludedTags', excludedTags.filter(t => t !== tag));
    } else {
        // Add to excluded and remove from included if present
        filtersStore.setKey('excludedTags', [...excludedTags, tag]);
        filtersStore.setKey('includedTags', includedTags.filter(t => t !== tag));
    }
}

// Shape / type filters. Each action replaces include+exclude in ONE store update
// so no intermediate contradictory state is ever observed or fetched.
export function toggleShape(key: ShapeKey) {
    const s = filtersStore.get();
    const next = cycleInclude({ included: s.includedShapes, excluded: s.excludedShapes }, key);
    filtersStore.set({ ...s, includedShapes: next.included, excludedShapes: next.excluded });
}

export function toggleShapeExclude(key: ShapeKey) {
    const s = filtersStore.get();
    const next = toggleExclude({ included: s.includedShapes, excluded: s.excludedShapes }, key);
    filtersStore.set({ ...s, includedShapes: next.included, excludedShapes: next.excluded });
}

export function toggleType(key: string) {
    const s = filtersStore.get();
    const next = cycleInclude({ included: s.includedTypes, excluded: s.excludedTypes }, key);
    filtersStore.set({ ...s, includedTypes: next.included, excludedTypes: next.excluded });
}

export function toggleTypeExclude(key: string) {
    const s = filtersStore.get();
    const next = toggleExclude({ included: s.includedTypes, excluded: s.excludedTypes }, key);
    filtersStore.set({ ...s, includedTypes: next.included, excludedTypes: next.excluded });
}

export function clearShapeFilter() {
    filtersStore.set({ ...filtersStore.get(), includedShapes: [], excludedShapes: [] });
}

export function clearTypeFilter() {
    filtersStore.set({ ...filtersStore.get(), includedTypes: [], excludedTypes: [] });
}

/** Commit a validated custom ratio (the pair changes atomically). */
export function setCustomRatio(ratio: CustomRatio) {
    const current = filtersStore.get().customRatio;
    if (current.width === ratio.width && current.height === ratio.height) return;
    filtersStore.setKey('customRatio', { width: ratio.width, height: ratio.height });
}

export function clearFilters() {
    // One update for every reset field (sort preferences are kept: they are
    // usually persistent choices)
    filtersStore.set({
        ...filtersStore.get(),
        search: '',
        folderId: null,
        includedTags: [],
        excludedTags: [],
        tagRule: 'all',
        color: null,
        colorAccuracy: 60,
        specialFilter: null,
        includedShapes: [],
        excludedShapes: [],
        customRatio: DEFAULT_CUSTOM_RATIO,
        includedTypes: [],
        excludedTypes: [],
    });
}

export function addRecentColor(hex: string) {
    const current = recentColorsStore.get();
    const filtered = current.filter(c => c !== hex);
    // Keep max 10 recent colors
    recentColorsStore.set([hex, ...filtered].slice(0, 10));
    try { localStorage.setItem('library_recent_colors', JSON.stringify(recentColorsStore.get())); } catch { /* storage blocked: session-only */ }
}

export function markFoldersUnlocked(ids: string[]) {
    const next = new Set(unlockedFoldersStore.get());
    ids.forEach(id => next.add(id));
    unlockedFoldersStore.set(next);
}

export function markFoldersLocked(ids: string[]) {
    const next = new Set(unlockedFoldersStore.get());
    ids.forEach(id => next.delete(id));
    unlockedFoldersStore.set(next);
}

export function toggleRecursive() {
    const current = filtersStore.get().recursive;
    filtersStore.setKey('recursive', !current);
}

// Initial client-side setup
if (typeof window !== 'undefined') {
    // Theme first and independent of storage: the inline head bootstrap in index.astro
    // already resolved saved > env > dark onto the root class.
    themeStore.set(document.documentElement.classList.contains('dark') ? 'dark' : 'light');

    // Every storage read is guarded; blocked storage keeps the defaults.
    const saved = readSavedPreferences(getBrowserStorage());
    if (saved.layout) layoutStore.set(saved.layout);
    if (saved.zoom !== null) zoomLevelStore.set(saved.zoom);
    if (saved.recentColors) recentColorsStore.set(saved.recentColors);
}
