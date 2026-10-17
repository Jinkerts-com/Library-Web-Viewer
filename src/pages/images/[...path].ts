import { libraryPath } from '../../lib/db';
import { createOriginalHandler } from '../../lib/mediaHandlers';
import { productionAccessDeps, ensureLockState } from '../../lib/mediaAccess';

export const GET = createOriginalHandler({
    access: productionAccessDeps,
    prepare: ensureLockState,
    getLibraryPath: () => libraryPath
});
