import { generatePreview } from '../../../lib/thumbnailUtils';
import { createPreviewHandler } from '../../../lib/mediaHandlers';
import { productionAccessDeps, ensureLockState } from '../../../lib/mediaAccess';

export const GET = createPreviewHandler({
    access: productionAccessDeps,
    prepare: ensureLockState,
    generatePreview
});
