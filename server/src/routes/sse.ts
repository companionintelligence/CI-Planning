import Router from '@koa/router';
import { PassThrough } from 'node:stream';
import { currentOwnerId } from '../lib/context.js';

const clients = new Map<PassThrough, number>(); // stream -> ownerId

/** Register an SSE client for an owner. Returns an unregister function. */
export function registerClient(stream: PassThrough, ownerId: string): () => void {
  clients.set(stream, ownerId);
  return () => {
    clients.delete(stream);
  };
}

/** Send an event only to the streams belonging to `ownerId`. */
export function broadcast(ownerId: string, event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [c, owner] of clients) if (owner === ownerId) c.write(msg);
}

export function sseRouter() {
  const router = new Router();

  router.get('/api/events', async (ctx) => {
    const stream = new PassThrough();
    ctx.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    ctx.status = 200;
    ctx.body = stream;

    // Capture the owner at connect time; this stream only receives their events.
    const unregister = registerClient(stream, currentOwnerId());
    stream.write(':ok\n\n');

    const heartbeat = setInterval(() => stream.write(':heartbeat\n\n'), 25_000);
    ctx.req.on('close', () => {
      clearInterval(heartbeat);
      unregister();
    });
  });

  return router;
}
