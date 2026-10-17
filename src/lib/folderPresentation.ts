/**
 * Alphabetical sidebar ordering. Returns a sorted copy so store-owned
 * (possibly frozen) folder arrays are never mutated during render.
 * Nested children are sorted by each FolderItem when it renders its own level.
 */
export function sortFoldersByName<T extends { name: string }>(folders: readonly T[]): T[] {
    return [...folders].sort((a, b) => a.name.localeCompare(b.name));
}
