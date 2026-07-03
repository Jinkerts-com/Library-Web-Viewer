import { atom, map } from 'nanostores';

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
export const layoutStore = atom<LayoutMode>('masonry');
export const sidebarOpenStore = atom<boolean>(false);
export const themeStore = atom<'light' | 'dark'>('light');
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
    recursive: false
});

// Actions
export const setSidebarOpen = (open: boolean) => sidebarOpenStore.set(open);
export const toggleSidebar = () => sidebarOpenStore.set(!sidebarOpenStore.get());
export const setZoom = (zoom: number) => {
    zoomLevelStore.set(zoom);
    localStorage.setItem('library_zoom', zoom.toString());
};

export const toggleTheme = () => {
    const newTheme = themeStore.get() === 'light' ? 'dark' : 'light';
    themeStore.set(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
};


// Actions
export async function fetchMetadata() {
    try {
        const res = await fetch('/api/meta');
        const data = await res.json();
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
    localStorage.setItem('library_layout', layout);
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

export function clearFilters() {
    filtersStore.setKey('search', '');
    filtersStore.setKey('folderId', null);
    filtersStore.setKey('includedTags', []);
    filtersStore.setKey('excludedTags', []);
    filtersStore.setKey('tagRule', 'all');
    filtersStore.setKey('color', null);
    filtersStore.setKey('colorAccuracy', 60);
    filtersStore.setKey('specialFilter', null);
    // Note: We keep sort preferences as they are usually persistent choices
}

export function addRecentColor(hex: string) {
    const current = recentColorsStore.get();
    const filtered = current.filter(c => c !== hex);
    // Keep max 10 recent colors
    recentColorsStore.set([hex, ...filtered].slice(0, 10));
    localStorage.setItem('library_recent_colors', JSON.stringify(recentColorsStore.get()));
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
    const savedLayout = localStorage.getItem('library_layout') as LayoutMode;
    if (savedLayout) layoutStore.set(savedLayout);

    const savedZoom = localStorage.getItem('library_zoom');
    if (savedZoom) zoomLevelStore.set(parseFloat(savedZoom));

    const savedTheme = localStorage.getItem('theme') || 'light';
    themeStore.set(savedTheme as 'light' | 'dark');
    if (savedTheme === 'dark') document.documentElement.classList.add('dark');

    const savedColors = localStorage.getItem('library_recent_colors');
    if (savedColors) {
        try {
            recentColorsStore.set(JSON.parse(savedColors));
        } catch (e) { }
    }
}
