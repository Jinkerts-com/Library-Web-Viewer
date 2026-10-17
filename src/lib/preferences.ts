/** Storage-safe preference reads for the client init block (blocked storage must never throw). */

export type LayoutModeValue = 'masonry' | 'justified' | 'grid';

export interface SavedPreferences {
    layout: LayoutModeValue | null;
    zoom: number | null;
    recentColors: string[] | null;
}

interface ReadableStorage { getItem(key: string): string | null }

const LAYOUTS: readonly string[] = ['masonry', 'justified', 'grid'];

function safeGet(storage: ReadableStorage | null | undefined, key: string): string | null {
    try {
        return storage ? storage.getItem(key) : null;
    } catch {
        return null; // storage blocked: session-only defaults
    }
}

/** Each preference is read independently; any failure or invalid value yields null (= keep default). */
export function readSavedPreferences(storage: ReadableStorage | null | undefined): SavedPreferences {
    const layoutRaw = safeGet(storage, 'library_layout');
    const layout = layoutRaw && LAYOUTS.includes(layoutRaw) ? (layoutRaw as LayoutModeValue) : null;

    const zoomRaw = safeGet(storage, 'library_zoom');
    const zoomNum = zoomRaw ? parseFloat(zoomRaw) : NaN;
    const zoom = Number.isFinite(zoomNum) ? zoomNum : null;

    let recentColors: string[] | null = null;
    const colorsRaw = safeGet(storage, 'library_recent_colors');
    if (colorsRaw) {
        try {
            const parsed = JSON.parse(colorsRaw);
            if (Array.isArray(parsed) && parsed.every(c => typeof c === 'string')) recentColors = parsed;
        } catch { /* corrupt value: ignore */ }
    }
    return { layout, zoom, recentColors };
}

/** Browser storage accessor that tolerates the property getter itself throwing. */
export function getBrowserStorage(): ReadableStorage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}
