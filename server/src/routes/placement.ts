import Router from '@koa/router';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { survivalTrend } from '../services/placement-learning.js';

/**
 * Placement-learning REST surface (ticket 6) — thin adapters over
 * services/placement-learning.ts; zero business logic lives here.
 *
 * No feature-flag gate, unlike routes/triality.ts: this learning has no flag to be
 * off. An owner who has corrected nothing simply has an empty trend, which is the
 * same thing the endpoint reports on a fresh install.
 *
 * Both routes are about the owner's OWN evidence, and neither can reach another
 * owner's: every statement filters on `currentOwnerId()`.
 */
export function placementRouter() {
  const router = new Router({ prefix: '/api/placement' });

  // GET /api/placement/survival — the measured trend, newest run first. Each row is
  // one weekly calibrate_placement reading of whether auto-placed blocks are
  // surviving the day untouched (plan: "the scheduler got better" is a claim; this
  // is the number). `survival_rate: null` means that run's period decided nothing —
  // a chart must draw a GAP there, never a 0.
  router.get('/survival', async (ctx) => {
    const limit = Math.min(Math.max(Number((ctx.query as Record<string, string>).limit) || 12, 1), 100);
    ctx.body = { runs: await survivalTrend(currentOwnerId(), limit) };
  });

  // DELETE /api/placement/preferences — "reset learning", the twin of DELETE
  // /api/classification/exemplars. Drops THIS owner's learned hour bands only; the
  // placement log survives untouched, so the next weekly pass re-earns the
  // adaptation rather than losing it. Owner-initiated write ⇒ audited (WHO rule),
  // unlike the batch that writes these rows.
  router.delete('/preferences', async (ctx) => {
    const owner = currentOwnerId();
    const res = await store().prepare(`DELETE FROM placement_preferences WHERE owner_id = ?`).run(owner);
    // Audit only a real reset — a no-op delete is not a mutation worth a row.
    if (res.changes > 0) {
      writeAudit({ ownerId: owner, actor: 'owner', action: 'reset', entity: 'placement:preferences' });
    }
    ctx.body = { ok: true, cleared: res.changes };
  });

  return router;
}
