import { ensureBooted, snapshot, subscribe } from '@/lib/store';

export const dynamic = 'force-dynamic';

const KEEPALIVE_MS = 20_000;

/** Server-sent events: one full snapshot after every agent tool call or other state change. */
export async function GET(req: Request) {
  await ensureBooted();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      send(snapshot());
      const unsubscribe = subscribe(send);
      const keepalive = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), KEEPALIVE_MS);
      req.signal.addEventListener('abort', () => {
        unsubscribe();
        clearInterval(keepalive);
        controller.close();
      });
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
  });
}
