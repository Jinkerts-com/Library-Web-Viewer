import { db, libraryPath } from '../../lib/db';
import { createHealthHandler } from '../../lib/health';

export const GET = createHealthHandler({
    getLibraryPath: () => libraryPath,
    probeDatabase: () => { db.query('SELECT 1').get(); }
});
