import Router from '@koa/router';
import { PassThrough } from 'node:stream';

const clients = new Set<PassThrough>();

export function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
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

    clients.add(stream);
    stream.write(':ok\n\n');

    const heartbeat = setInterval(() => stream.write(':heartbeat\n\n'), 25_000);
    ctx.req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(stream);
    });
  });

  return router;
}
