/**
 * Shared client-side item shape plus read-only display formatting for the
 * modal's metadata panel. Formatters never throw and never emit
 * "Invalid Date"/"NaN": unusable input yields null and the caller omits the row.
 */

export interface LibraryItem {
    id: string;
    name: string;
    ext: string;
    width: number;
    height: number;
    size: number;
    /** Unix milliseconds */
    modificationTime: number;
    /** Unix milliseconds. The scanner substitutes modificationTime when Eagle had none. */
    btime?: number | null;
    /** Eagle rating; 0 when unrated. */
    star?: number | null;
    /** Fractional SECONDS; 0 for non-media. */
    duration?: number | null;
    description?: string;
    tags?: string[];
}

const isPositiveFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Formats Unix milliseconds for display; null for 0/negative/missing/non-numeric/out-of-range values. */
export function formatTimestamp(ms: unknown, locale?: string): string | null {
    if (!isPositiveFinite(ms)) return null;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    try {
        return date.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
        return null;
    }
}

/**
 * "Date Added" source is `btime`. The scan stores `btime || modificationTime`,
 * so a stored btime equal to modificationTime cannot be told apart from the
 * substituted fallback (the DB keeps no provenance). Such values are omitted
 * rather than presented as a proven creation time; the same instant is already
 * shown as "Modified".
 */
export function dateAdded(item: Pick<LibraryItem, 'btime' | 'modificationTime'>, locale?: string): string | null {
    if (!isPositiveFinite(item.btime)) return null;
    if (item.btime === item.modificationTime) return null;
    return formatTimestamp(item.btime, locale);
}

/** Duration in fractional seconds -> "m:ss" or "h:mm:ss" (whole seconds, floored); null unless > 0 and finite. */
export function formatDuration(seconds: unknown): string | null {
    if (!isPositiveFinite(seconds)) return null;
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const MAX_RATING = 5;

/** Whole-star rating 1..5, or null when unrated/unknown. Out-of-range values are not guessed at. */
export function ratingStars(star: unknown): number | null {
    if (typeof star !== 'number' || !Number.isInteger(star)) return null;
    return star >= 1 && star <= MAX_RATING ? star : null;
}
