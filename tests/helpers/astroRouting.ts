import { parseOriginalPath } from '../../src/lib/originalPath';
// The REAL installed Astro utility (not a copy), so router drift shows up as a test failure.
import { MultiLevelEncodingError, validateAndDecodePathname } from '../../node_modules/astro/dist/core/util/pathname.js';

/**
 * What Astro does to a request path before route code runs (core/util/pathname.js):
 * `%25` + two hex digits is rejected with 400 both BEFORE and AFTER one decodeURI
 * (the post-decode check catches e.g. `%%32%3541`, which decodes to `%2541`);
 * reserved escapes such as %23 %3F %2B stay encoded; a throwing decodeURI falls back
 * to the raw path (measured against dev and built servers, see docs/plan.md P3.4).
 */
export function astroParams(pathname: string, prefix = '/images/'): string | 'ROUTER_400' {
    let decoded: string;
    try {
        decoded = validateAndDecodePathname(pathname);
    } catch (e) {
        if (e instanceof MultiLevelEncodingError) return 'ROUTER_400';
        decoded = pathname; // malformed escape: raw path reaches the route
    }
    return decoded.slice(prefix.length);
}

/** Client URL -> what the route's file resolution is asked for. */
export function roundTrip(url: string) {
    const u = new URL(url, 'http://app');
    const param = astroParams(u.pathname);
    if (param === 'ROUTER_400') return 'ROUTER_400' as const;
    return parseOriginalPath(param, u.searchParams.get('n'));
}
