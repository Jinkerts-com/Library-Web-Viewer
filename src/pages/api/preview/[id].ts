import type { APIRoute } from 'astro';
import { generatePreview } from '../../../lib/thumbnailUtils';
import { db } from '../../../lib/db';

export const GET: APIRoute = async ({ params, request }) => {
    const id = params.id;
    if (!id) {
        return new Response("Missing id", { status: 400 });
    }

    try {
        const item = db.query("SELECT ext FROM items WHERE id = ?").get(id) as { ext: string } | undefined;
        if (!item) {
            return new Response("Not found", { status: 404 });
        }

        const buffer = await generatePreview(id, item.ext);

        if (!buffer) {
            return new Response("Preview unavailable", { status: 404 });
        }

        return new Response(new Uint8Array(buffer), {
            status: 200,
            headers: {
                'Content-Type': 'image/webp',
                'Cache-Control': 'public, max-age=604800, immutable'
            }
        });
    } catch (error) {
        console.error(`Error serving preview for ${id}:`, error);
        return new Response("Internal Server Error", { status: 500 });
    }
};
