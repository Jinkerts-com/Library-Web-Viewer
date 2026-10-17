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

export function originalUrl(id: string, name: string, ext: string, epoch?: string): string {
    return withMediaEpoch(`/images/${id}.info/${name}.${ext}`, epoch);
}
