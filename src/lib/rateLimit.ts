/**
 * In-memory, per-process throttling primitives. Pure (no import-time side
 * effects, injectable clock) so tests drive them with a fake `now`.
 *
 * These are defense in depth, NOT authentication. State lives in this process
 * only: several server instances do not share counters (shared limiting is out
 * of scope). Nothing here is permanent: every block expires on its own.
 */

export type RateDecision =
    | { allowed: true; remaining: number }
    | { allowed: false; retryAfterSeconds: number };

export interface RateLimiterOptions {
    /** Requests allowed per key per window. */
    limit: number;
    windowMs: number;
    /** Hard cap on tracked keys; the oldest entries are evicted beyond it. */
    maxKeys?: number;
    now?: () => number;
}

export interface RateLimiter {
    /** Counts one request for `key` and says whether it is allowed. */
    take(key: string): RateDecision;
    /** Number of currently tracked keys (never exceeds `maxKeys`). */
    readonly size: number;
}

export const DEFAULT_MAX_KEYS = 10_000;

const retryAfter = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Fixed-window counter per key. Every entry is created with the same window
 * length, so insertion order of the Map equals expiry order: expired entries
 * are always at the front and eviction is a cheap walk from the front, while
 * the cap (also evicting from the front, i.e. the oldest window) bounds memory
 * even under a flood of distinct keys. A key that is rejected never extends its
 * own window, so a blocked client is released when the window ends.
 */
export function createRateLimiter({ limit, windowMs, maxKeys = DEFAULT_MAX_KEYS, now = Date.now }: RateLimiterOptions): RateLimiter {
    if (!(limit >= 1) || !(windowMs > 0) || !(maxKeys >= 1)) throw new Error('Invalid rate limiter configuration');
    const entries = new Map<string, { count: number; resetAt: number }>();

    function evict(t: number) {
        for (const [key, entry] of entries) {
            if (entry.resetAt > t) break;
            entries.delete(key);
        }
        while (entries.size >= maxKeys) {
            const oldest = entries.keys().next();
            if (oldest.done) break;
            entries.delete(oldest.value);
        }
    }

    return {
        take(key) {
            const t = now();
            let entry = entries.get(key);
            // expired, or the clock moved backwards past a whole window: start over
            if (entry && (entry.resetAt <= t || entry.resetAt - t > windowMs)) {
                entries.delete(key);
                entry = undefined;
            }
            if (!entry) {
                evict(t);
                entry = { count: 0, resetAt: t + windowMs };
                entries.set(key, entry);
            }
            if (entry.count >= limit) return { allowed: false, retryAfterSeconds: retryAfter(entry.resetAt - t) };
            entry.count++;
            return { allowed: true, remaining: limit - entry.count };
        },
        get size() { return entries.size; }
    };
}

export type CooldownDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface Cooldown {
    check(): CooldownDecision;
    /** (Re)starts the cooldown from now. */
    start(): void;
}

/** Process-wide "not again for `ms`" gate (used for scans, which are a global resource). */
export function createCooldown({ ms, now = Date.now }: { ms: number; now?: () => number }): Cooldown {
    let until = 0;
    return {
        check() {
            const t = now();
            if (until <= t || until - t > ms) return { allowed: true }; // expired (or clock went backwards)
            return { allowed: false, retryAfterSeconds: retryAfter(until - t) };
        },
        start() { until = ms > 0 ? now() + ms : 0; }
    };
}

/** Positive integer from an env value; anything else (unset, 0, negative, junk) yields the default. */
export function readPositiveInt(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return value !== undefined && value.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** Non-negative integer from an env value (0 is meaningful: "disabled"). */
export function readNonNegativeInt(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return value !== undefined && value.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}
