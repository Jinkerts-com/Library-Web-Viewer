import type { APIRoute } from 'astro';
import { scanEmitter, getScanStatus } from '../../../lib/db';

export const GET: APIRoute = async ({ request }) => {
    let cleanup: () => void;

    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();

            const send = (data: any) => {
                try {
                    const message = `data: ${JSON.stringify(data)}\n\n`;
                    controller.enqueue(encoder.encode(message));
                } catch (e) {
                    if (cleanup) cleanup();
                }
            };

            // Send initial status immediately
            send(getScanStatus());

            const listener = (data: any) => send(data);
            const completeListener = (data: any) => send(data);

            scanEmitter.on('progress', listener);
            scanEmitter.on('complete', completeListener);

            // Keep-alive heartbeat every 15s
            const interval = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(`: keep-alive\n\n`));
                } catch (e) {
                    if (cleanup) cleanup();
                }
            }, 15000);

            cleanup = () => {
                clearInterval(interval);
                scanEmitter.removeListener('progress', listener);
                scanEmitter.removeListener('complete', completeListener);
            };

            request.signal.addEventListener('abort', cleanup);
        },
        cancel() {
            if (cleanup) cleanup();
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
