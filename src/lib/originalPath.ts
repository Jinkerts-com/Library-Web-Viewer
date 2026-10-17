/**
 * Server-side decoding of the original route's path parameter.
 *
 * Measured against Astro 6.4.4 (dev and built node server): the router applies
 * `decodeURI` ONCE to the request pathname before it builds `params`, and rejects
 * (400, before any route code runs) any path containing `%25` + two hex digits
 * ("multi-level encoding"). `decodeURI` leaves the reserved escapes
 * `; / ? : @ & = + $ , #` encoded, so `params.path` still holds `%23`, `%3F`, `%2B`...
 *
 * Therefore the route owns exactly the remaining decode: reserved escapes only.
 * Any other `%XX` still present means Astro's decodeURI threw and fell back to the
 * raw path (malformed escape) -> invalid. A literal "%" is never ambiguous here:
 * it reached us either as a lone "%" or inside an escape Astro already decoded,
 * and "%25XX" cannot arrive at all (see `originalUrl` in mediaUrls for the carrier
 * used for such names).
 */

const RESERVED_ESCAPES = new Set(['23', '24', '26', '2B', '2C', '2F', '3A', '3B', '3D', '3F', '40']);

/** Decode the escapes `decodeURI` leaves behind; null when any other escape remains. */
export function decodeReservedEscapes(segment: string): string | null {
    let invalid = false;
    const out = segment.replace(/%([0-9a-fA-F]{2})/g, (m, hex: string) => {
        const up = hex.toUpperCase();
        if (!RESERVED_ESCAPES.has(up)) { invalid = true; return m; }
        return String.fromCharCode(parseInt(up, 16));
    });
    return invalid ? null : out;
}

export type ParsedOriginalPath =
    | { ok: true; itemId: string; fileName: string }
    | { ok: false; status: 400 | 404 };

/**
 * `<id>.info/<file>` from Astro's `params.path`. `nameOverride` (the `n` query value,
 * already decoded once by URLSearchParams) replaces the file segment when present.
 */
export function parseOriginalPath(pathParam: string, nameOverride?: string | null): ParsedOriginalPath {
    const decoded = pathParam.split('/').map(decodeReservedEscapes);
    // Malformed escaping is a request-syntax error (checked first), not an existence oracle
    if (decoded.includes(null)) return { ok: false, status: 400 };
    const [dir, file] = decoded as string[];
    if (decoded.length !== 2 || !dir.endsWith('.info')) return { ok: false, status: 404 };
    return { ok: true, itemId: dir.slice(0, -'.info'.length), fileName: nameOverride ?? file };
}
