
import { generateThumbnail } from '../../../lib/thumbnailUtils';
import { getPlaceholderResponse } from '../../../lib/placeholder';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ params }) => {
    const itemId = params.id;

    if (!itemId) {
        return getPlaceholderResponse();
    }

    const buffer = await generateThumbnail(itemId);

    if (buffer) {
        return new Response(buffer as unknown as BodyInit, {
            headers: {
                "Content-Type": "image/webp",
                "Cache-Control": "public, max-age=31536000, immutable"
            }
        });
    } else {
        return getPlaceholderResponse();
    }
}
