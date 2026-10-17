/** Focus helpers for the facet popover (kept DOM-free so they are unit-testable). */

interface Focusable { focus(): void }

/** Escape closes the popover and returns focus to the originating chip. Returns true if handled. */
export function handleFacetEscape(key: string, close: () => void, chip: Focusable | null): boolean {
    if (key !== 'Escape') return false;
    close();
    chip?.focus();
    return true;
}

/**
 * Callback-ref factory: focuses the panel exactly when a new node mounts.
 * Pass the result as a STABLE ref (useCallback/useMemo) so re-renders never refocus.
 */
export function focusOnMount(): (node: Focusable | null) => void {
    let current: Focusable | null = null;
    return node => {
        if (node && node !== current) node.focus();
        current = node;
    };
}
