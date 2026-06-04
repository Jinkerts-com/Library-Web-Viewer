import { performLibraryScan } from '../../lib/db';
import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request }) => {
    try {
        console.log("[API] Manual scan triggered");

        void performLibraryScan();

        return new Response(JSON.stringify({ message: "Scan started" }), {
            headers: { "Content-Type": "application/json" }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: (error as Error).message }), { status: 500 });
    }
}
