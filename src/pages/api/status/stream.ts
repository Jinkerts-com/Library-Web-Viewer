import type { APIRoute } from 'astro';
import { scanEmitter, getScanStatus } from '../../../lib/db';
import { createStatusStream } from '../../../lib/sseStream';

export const GET: APIRoute = async ({ request }) => {
    const stream = createStatusStream({
        emitter: scanEmitter,
        getStatus: getScanStatus,
        signal: request.signal
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
