import { createScanHandler, type StartScanResult } from './scanLifecycle';
import type { Cooldown, RateLimiter } from './rateLimit';

/**
 * Defense in depth for state-changing endpoints (scan / unlock / lock). This is
 * NOT authentication and there is no account system. The seams are deliberately
 * small and replaceable so a future account system can slot in:
 *  - `resolveKey` decides WHO a request is charged to (today: client address;
 *    an account layer could return a user id instead);
 *  - a guard is just `(ctx) => Response | null` and can be composed with more checks.
 *
 * Pure: no import-time side effects, no env reads (see requestGuards.ts for the
 * production wiring).
 */

export interface GuardContext {
    request: Request;
    /** Astro's adapter-provided address; reading it may throw when the adapter has none. */
    clientAddress?: string;
}

export type RequestGuard = (ctx: GuardContext) => Response | null;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * The client address as provided by the server adapter, i.e. the TCP peer
 * (`socket.remoteAddress`). `X-Forwarded-For` and similar headers are
 * deliberately NEVER read here: any client can forge them, which would let an
 * attacker pick a fresh rate-limit bucket per request.
 * (Astro's Node adapter itself only honours X-Forwarded-For when
 * `security.allowedDomains` is configured, which this project does not do.)
 * Behind a reverse proxy every request therefore appears to come from the
 * proxy and shares one bucket; that is the safe failure mode.
 */
export function resolveClientAddress(ctx: GuardContext): string {
    let address: unknown;
    try {
        address = ctx.clientAddress;
    } catch {
        return 'unknown';
    }
    if (typeof address !== 'string' || !address) return 'unknown';
    // ::ffff:1.2.3.4 and 1.2.3.4 are the same peer
    return address.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
}

export type OriginCheck = { ok: true } | { ok: false; reason: string };

function hostOf(value: string): string | null {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.host ? url.host.toLowerCase() : null;
    } catch {
        return null;
    }
}

/**
 * Same-origin policy for browser-originated mutations (CSRF defense):
 *  - `Sec-Fetch-Site`, when sent, must be `same-origin` (or `none`: user-initiated);
 *    `cross-site` and `same-site` (other ports/subdomains) are rejected.
 *  - `Origin`, when sent, must name the host the request was addressed to
 *    (`Host` header). `Origin: null` and unparsable values are rejected.
 *  - Without `Origin` and `Sec-Fetch-Site`, `Referer` is checked when present.
 *  - Requests with NONE of these headers (curl, scripts, other servers) are
 *    allowed: they are not browsers, so cross-site request forgery does not apply
 *    to them. They are still subject to rate limits.
 * Host (not `request.url`) is compared because the adapter does not always
 * reflect the real Host in the URL; browsers cannot forge the Host header.
 */
export function checkSameOrigin(request: Request): OriginCheck {
    const headers = request.headers;
    const site = headers.get('sec-fetch-site')?.trim().toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'cross-site request' };

    let expectedHost: string;
    try {
        expectedHost = (headers.get('host') ?? new URL(request.url).host).trim().toLowerCase();
    } catch {
        return { ok: false, reason: 'unknown host' };
    }

    const origin = headers.get('origin');
    if (origin !== null) {
        return hostOf(origin) === expectedHost ? { ok: true } : { ok: false, reason: 'origin mismatch' };
    }
    if (!site) {
        const referer = headers.get('referer');
        if (referer) return hostOf(referer) === expectedHost ? { ok: true } : { ok: false, reason: 'referer mismatch' };
    }
    return { ok: true };
}

export const FORBIDDEN_MESSAGE = 'Cross-origin request rejected';
export const RATE_LIMITED_MESSAGE = 'Too many requests. Please try again later.';

export function forbiddenResponse(): Response {
    return json({ success: false, error: FORBIDDEN_MESSAGE }, 403);
}

export function tooManyRequests(retryAfterSeconds: number): Response {
    return json(
        { success: false, error: RATE_LIMITED_MESSAGE, status: 'rate_limited', retryAfterSeconds },
        429,
        { 'Retry-After': String(retryAfterSeconds) }
    );
}

export interface MutationGuardOptions {
    /** Omit for same-origin checking only (e.g. lock). */
    limiter?: RateLimiter;
    /** Namespaces buckets so endpoints never share counters. */
    scope: string;
    /** Who the request is charged to. Replace with an account id when accounts exist. */
    resolveKey?: (ctx: GuardContext) => string;
}

/** Same-origin check (403), then rate limit (429 + Retry-After). Returns null when the request may proceed. */
export function createMutationGuard({ limiter, scope, resolveKey = resolveClientAddress }: MutationGuardOptions): RequestGuard {
    return (ctx) => {
        if (!checkSameOrigin(ctx.request).ok) return forbiddenResponse();
        if (limiter) {
            const decision = limiter.take(`${scope}:${resolveKey(ctx)}`);
            if (!decision.allowed) return tooManyRequests(decision.retryAfterSeconds);
        }
        return null;
    };
}

export interface GuardedScanOptions {
    guard: RequestGuard;
    cooldown: Cooldown;
    isScanning: () => boolean;
    start: () => StartScanResult;
    log?: { info(...a: any[]): void; error(...a: any[]): void };
}

/**
 * POST /api/scan with protection layered over the P1.3 handler, whose response
 * shapes (200 accepted / 409 busy / 503 unconfigured / 500) are unchanged.
 * The cooldown is global (a scan is a process-wide resource) and (re)starts
 * when a scan is accepted and again when it finishes. While a scan is running
 * the request falls through to the handler so callers still get the 409 busy.
 */
export function createGuardedScanRoute({ guard, cooldown, isScanning, start, log }: GuardedScanOptions) {
    const handler = createScanHandler(() => {
        const started = start();
        if (started.kind === 'accepted') {
            cooldown.start();
            started.done.then(() => cooldown.start(), () => cooldown.start());
        }
        return started;
    }, log);
    return async (ctx: GuardContext): Promise<Response> => {
        const blocked = guard(ctx);
        if (blocked) return blocked;
        if (!isScanning()) {
            const gate = cooldown.check();
            if (!gate.allowed) return tooManyRequests(gate.retryAfterSeconds);
        }
        return handler();
    };
}
