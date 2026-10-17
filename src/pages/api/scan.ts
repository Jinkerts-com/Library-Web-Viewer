import { getScanStatus, startLibraryScan } from '../../lib/db';
import { createGuardedScanRoute } from '../../lib/requestSecurity';
import { scanCooldown, scanGuard } from '../../lib/requestGuards';
import type { APIRoute } from 'astro';

// 200 accepted ({ message: "Scan started" }) | 409 busy | 503 library not configured | 500 generic,
// plus 403 (cross-origin) and 429 + Retry-After (rate limit / cooldown) from the guards.
// Response shapes and sanitization of the scan outcomes live in lib/scanLifecycle.ts.
export const POST: APIRoute = createGuardedScanRoute({
    guard: scanGuard,
    cooldown: scanCooldown,
    isScanning: () => getScanStatus().isScanning,
    start: startLibraryScan
});
