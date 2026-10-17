import { createCooldown, createRateLimiter, readNonNegativeInt, readPositiveInt } from './rateLimit';
import { createMutationGuard } from './requestSecurity';

/**
 * Production wiring for the request guards: process-wide limiters configured
 * from the environment (read once at startup). All state is per process.
 *
 *   UNLOCK_RATE_LIMIT        unlock attempts per client per window (default 10)
 *   UNLOCK_RATE_WINDOW_SECONDS  window length (default 60)
 *   SCAN_RATE_LIMIT          scan requests per client per window (default 5)
 *   SCAN_RATE_WINDOW_SECONDS window length (default 60)
 *   SCAN_COOLDOWN_SECONDS    global pause after a scan starts/finishes (default 10, 0 = off)
 */
const env = process.env;

const unlockLimiter = createRateLimiter({
    limit: readPositiveInt(env.UNLOCK_RATE_LIMIT, 10),
    windowMs: readPositiveInt(env.UNLOCK_RATE_WINDOW_SECONDS, 60) * 1000
});

const scanLimiter = createRateLimiter({
    limit: readPositiveInt(env.SCAN_RATE_LIMIT, 5),
    windowMs: readPositiveInt(env.SCAN_RATE_WINDOW_SECONDS, 60) * 1000
});

export const scanCooldown = createCooldown({ ms: readNonNegativeInt(env.SCAN_COOLDOWN_SECONDS, 10) * 1000 });

export const unlockGuard = createMutationGuard({ scope: 'unlock', limiter: unlockLimiter });
export const scanGuard = createMutationGuard({ scope: 'scan', limiter: scanLimiter });
/** Lock only revokes access; same-origin checking is enough. */
export const lockGuard = createMutationGuard({ scope: 'lock' });
