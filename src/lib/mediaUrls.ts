/**
 * Client-safe media URL construction (no imports: bundled into the browser).
 *
 * Cache-policy epoch. Before P2.2 the media routes answered with
 * `public, immutable, max-age=<1 year | 7 days>` on URLs that are not
 * content-hashed, so browsers may hold stale bytes under the bare URL form
 * (`/api/thumbnail/<id>`). Headers cannot revoke an already-cached immutable
 * response, so every URL this app constructs carries `?v=<epoch>`: a different
 * URL, hence a cache miss, hence the new private-revalidation policy applies.
 *
 * Bump MEDIA_CACHE_EPOCH whenever the cache policy of the media routes changes
 * in a way that requires clients to stop reusing earlier responses.
 *
 * Inherent limit: a browser that cached the OLD bare URL keeps those bytes until
 * its own cache expiry/eviction, and old bookmarks/links that use the bare URL
 * form keep resolving (the route shape is unchanged) but may be served from that
 * stale browser entry. Only URLs built by this client are guaranteed fresh.
 */
export const MEDIA_CACHE_EPOCH = '2';

export function withMediaEpoch(url: string, epoch: string = MEDIA_CACHE_EPOCH): string {
    return `${url}?v=${encodeURIComponent(epoch)}`;
}

export function thumbnailUrl(id: string, epoch?: string): string {
    return withMediaEpoch(`/api/thumbnail/${id}`, epoch);
}

export function previewUrl(id: string, epoch?: string): string {
    return withMediaEpoch(`/api/preview/${id}`, epoch);
}

/**
 * Original-file URL: `/images/<id>.info/<file>?v=<epoch>[&n=<file>][&download=1]`.
 *
 * Each path segment is percent-encoded exactly once (`encodeURIComponent`: spaces,
 * `%`, `#`, `?`, `&`, `+`, Unicode all safe). The server undoes exactly that (see
 * originalPath.ts). Two filename shapes cannot be carried in the path:
 *  - literal "%" + two hex digits: the router rejects every `%25XX` path (400), so the
 *    exact name travels in the `n` query parameter and the path segment is a neutral
 *    placeholder;
 *  - names containing "/" or "\" (never a single directory entry, whatever else they
 *    contain) carry an explicit `recover=1` flag: the path segment is a neutral
 *    placeholder the server IGNORES, and only the item's sole eligible original is
 *    served (several -> 409). The placeholder is never matched as a real filename.
 * Segments are never double-encoded: callers pass raw names, not encoded ones.
 */
export function originalUrl(id: string, name: string, ext: string, epoch?: string, opts: { download?: boolean } = {}): string {
    const file = `${name}.${ext}`;
    const unaddressable = /[\/\\]/.test(file);
    const needsQuery = !unaddressable && /%[0-9a-fA-F]{2}/.test(file);
    const segment = needsQuery || unaddressable ? `original.${ext}` : file;
    let url = withMediaEpoch(`/images/${encodeURIComponent(id)}.info/${encodeURIComponent(segment)}`, epoch);
    if (unaddressable) url += '&recover=1';
    else if (needsQuery) url += `&n=${encodeURIComponent(file)}`;
    if (opts.download) url += '&download=1';
    return url;
}

/** Props for the "open original" link: new tab, never handing the opener to the target. */
export function openOriginalLinkProps(id: string, name: string, ext: string) {
    return {
        href: originalUrl(id, name, ext),
        target: '_blank',
        rel: 'noopener noreferrer',
    } as const;
}

/** Props for the "download" link: the server answers with Content-Disposition: attachment. */
export function downloadLinkProps(id: string, name: string, ext: string) {
    return {
        href: originalUrl(id, name, ext, undefined, { download: true }),
        download: `${name}.${ext}`,
    } as const;
}
