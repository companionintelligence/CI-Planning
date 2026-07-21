import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { listConnections, disconnectConnection } from '../lib/connections.js';

/**
 * T13 (#349) — the stable, provider-agnostic connection surface the Settings
 * "Connections" tab (and later Wave-5 sharing) builds on. Owner-scoped by
 * currentOwnerId() on every call; auth/scope is enforced globally by requireAuth
 * (app.ts) — GET needs planning:read, DELETE needs planning:write — so there is no
 * per-route guard here.
 *
 * Both routes are leak-safe: GET returns only { provider, account, status, createdAt }
 * (listConnections never selects or decrypts token material); DELETE delegates to the
 * shared disconnectConnection() (best-effort Google revoke + hard-delete of the token
 * row and its outbound_queue rows).
 */
export function connectionsRouter(): Router {
  const router = new Router({ prefix: '/api/connections' });

  // ── GET /api/connections ────────────────────────────────────────────────────
  // Every connection the current owner holds, across providers. Never any secrets.
  router.get('/', (ctx) => {
    ctx.body = { connections: listConnections(currentOwnerId()) };
  });

  // ── DELETE /api/connections/:provider/:account ──────────────────────────────
  // Generic disconnect. :account is URL-decoded by the router (emails carry '@'/'+').
  // 200 { disconnected: { provider, account } } on removal; 404 when the owner holds
  // no such connection.
  router.delete('/:provider/:account', async (ctx) => {
    const ownerId = currentOwnerId();
    const { provider, account } = ctx.params;

    const removed = await disconnectConnection(ownerId, provider, account);
    if (!removed) {
      ctx.status = 404;
      ctx.body = { error: 'connection_not_found' };
      return;
    }

    ctx.body = { disconnected: { provider, account } };
  });

  return router;
}
