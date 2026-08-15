import Router from '@koa/router';
import type Koa from 'koa';
import { currentScopes, currentOwnerId } from '../lib/context.js';
import { hasAdminScope } from '../lib/auth/scopes.js';
import { writeAudit } from '../lib/audit.js';
import { broadcast } from './sse.js';
import { seedDemoData } from '../services/demo-data.js';

/**
 * The FTUE "Try with sample data" action.
 *
 * Admin-gated, matching routes/google-config.ts — loading sample data writes real rows
 * into the owner's board, so it is setup, not browsing.
 *
 * This replaced a client-side sequence that flipped Google into `fixture` mode and ran
 * the ingest jobs. That had two problems worth stating: it installed a connector CONFIG
 * as a side effect of asking for sample data (the owner then had a "connected" source
 * they never chose), and what it produced depended on fixture files. One endpoint that
 * inserts a known set is both smaller and honest about what it does.
 */

function requireAdmin(ctx: Koa.Context): boolean {
  if (hasAdminScope(currentScopes())) return true;
  ctx.status = 403;
  ctx.body = { error: 'forbidden' };
  return false;
}

export function demoRouter() {
  const router = new Router({ prefix: '/api/demo' });

  // POST /api/demo/sample-data — install the curated demo set for THIS owner.
  // Idempotent: a second call reports `skipped` rather than duplicating the set, so a
  // double-tap or a re-entered wizard cannot leave the owner tidying up by hand.
  router.post('/sample-data', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const owner = currentOwnerId();
    const result = await seedDemoData(owner);

    if (!result.skipped) {
      writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: 'demo:sample-data' });
      // The wizard's next step reads tasks and blocks; without these the board looks
      // empty until something else happens to refetch.
      broadcast(owner, 'task:created', { source: 'demo' });
      broadcast(owner, 'block:created', { source: 'demo' });
    }
    ctx.body = result;
  });

  return router;
}
