import fs from 'fs';

/**
 * GET /api/health: readiness for container orchestrators and uptime monitors.
 *
 * Ready means the process can serve: the configured library directory exists and
 * is readable, and the index database answers a trivial query. It deliberately
 * does NOT look at scan state (a scan in progress is normal operation), lock
 * metadata, or item counts, and it never scans, walks the library, or writes.
 *
 * The response body is sanitized: it carries only coarse per-check states, never
 * filesystem paths, error text or counts. Details go to the server log, and only
 * when the failure signature changes, so a polling healthcheck cannot flood it.
 */

export type CheckState = 'ok' | 'unavailable' | 'not_configured';

export interface HealthBody {
    status: 'ok' | 'unavailable';
    checks: { library: CheckState; database: CheckState };
}

export interface HealthDeps {
    getLibraryPath: () => string;
    /** Throws when the database cannot answer a trivial query. */
    probeDatabase: () => void;
    log?: (message: string) => void;
}

function checkLibrary(libraryPath: string): { state: CheckState; detail?: string } {
    if (!libraryPath) return { state: 'not_configured', detail: 'LIBRARY_PATH is not set' };
    try {
        if (!fs.statSync(libraryPath).isDirectory()) {
            return { state: 'unavailable', detail: `library path is not a directory: ${libraryPath}` };
        }
        fs.accessSync(libraryPath, fs.constants.R_OK | fs.constants.X_OK);
        return { state: 'ok' };
    } catch (err) {
        return { state: 'unavailable', detail: `library path is not readable (${libraryPath}): ${(err as Error).message}` };
    }
}

function checkDatabase(probe: () => void): { state: CheckState; detail?: string } {
    try {
        probe();
        return { state: 'ok' };
    } catch (err) {
        return { state: 'unavailable', detail: `database check failed: ${(err as Error).message}` };
    }
}

export function createHealthHandler({ getLibraryPath, probeDatabase, log = (m) => console.error(m) }: HealthDeps) {
    let lastLogged = '';

    return (): Response => {
        const library = checkLibrary(getLibraryPath());
        const database = checkDatabase(probeDatabase);
        const healthy = library.state === 'ok' && database.state === 'ok';

        const signature = [library.detail, database.detail].filter(Boolean).join(' | ');
        if (signature !== lastLogged) {
            const wasFailing = lastLogged !== '';
            lastLogged = signature;
            try {
                if (!healthy) log(`[HEALTH] Not ready: ${signature}`);
                else if (wasFailing) log('[HEALTH] Recovered: library and database are available.');
            } catch { /* reporting is best-effort */ }
        }

        const body: HealthBody = {
            status: healthy ? 'ok' : 'unavailable',
            checks: { library: library.state, database: database.state }
        };
        return new Response(JSON.stringify(body), {
            status: healthy ? 200 : 503,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            }
        });
    };
}
