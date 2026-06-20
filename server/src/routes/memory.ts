import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { memoryStatus, syncToMemory } from '../services/memory.js';

export function memoryRouter() {
  const router = new Router();

  // GET /api/memory/status — connection + sync state for the Settings panel.
  router.get('/api/memory/status', async (ctx) => {
    ctx.body = memoryStatus(currentOwnerId());
  });

  // POST /api/memory/sync — trigger a one-way push now. Stubbed until the Phase
  // I/J connector lands: returns 503 'unavailable' (sync off → 400, not connected → 400).
  router.post('/api/memory/sync', async (ctx) => {
    const r = syncToMemory(currentOwnerId());
    if (!r.ok) {
      ctx.status = r.reason === 'unavailable' ? 503 : 400;
      ctx.body = {
        reason: r.reason,
        error:
          r.reason === 'disabled'
            ? 'Memory sync is turned off'
            : r.reason === 'not_connected'
              ? 'Connect Companion Memory first'
              : 'Companion Memory sync arrives with the auth phase — not available yet',
      };
      return;
    }
    ctx.body = r;
  });

  return router;
}
