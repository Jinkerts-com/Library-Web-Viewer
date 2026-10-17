import { generateThumbnail, cachedMediaMtime } from '../../../lib/thumbnailUtils';
import { createThumbnailHandler } from '../../../lib/mediaHandlers';
import { productionAccessDeps, ensureLockState } from '../../../lib/mediaAccess';

export const GET = createThumbnailHandler({
    access: productionAccessDeps,
    prepare: ensureLockState,
    generateThumbnail,
    lastModified: (id) => cachedMediaMtime('thumbnail', id)
});
