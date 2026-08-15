import Router from '@koa/router';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { accuracyTrend, FIELDS } from '../services/classification-learning.js';

/**
 * Classification-learning REST surface (Phase 8) — thin adapters over
 * services/classification-learning.ts; zero business logic lives here.
 *
 * No feature-flag gate, unlike routes/triality.ts: this learning has no flag to be
 * off. An owner who has never corrected anything simply has an empty trend and an
 * empty index, which is the same thing the endpoints report on a fresh install.
 *
 * Both routes are about the owner's OWN evidence, and neither can reach another
 * owner's: every statement filters on `currentOwnerId()`.
 */
export function classificationRouter() {
  const router = new Router({ prefix: '/api/classification' });

  // GET /api/classification/accuracy — the measured trend, newest run first. Each row
  // is one field's held-out score for one calibration run (plan point 4: "better" is a
  // number, not a claim). `accuracy: null` means that run measured nothing — no Ollama
  // to grade with, or nothing held out — and a chart must draw a GAP there, never a 0.
  router.get('/accuracy', async (ctx) => {
    const limit = Math.min(Math.max(Number((ctx.query as Record<string, string>).limit) || 12, 1), 100);
    ctx.body = { fields: FIELDS, runs: await accuracyTrend(currentOwnerId(), limit) };
  });

  // DELETE /api/classification/exemplars — "reset learning", the twin of DELETE
  // /api/triality/weights. Drops THIS owner's learned index only; the correction log
  // survives untouched, so the next weekly pass re-earns the adaptation rather than
  // losing it. Owner-initiated write ⇒ audited (WHO rule), unlike the job that writes
  // these rows.
  router.delete('/exemplars', async (ctx) => {
    const owner = currentOwnerId();
    const res = await store().prepare(`DELETE FROM classification_exemplars WHERE owner_id = ?`).run(owner);
    // Audit only a real reset — a no-op delete is not a mutation worth a row.
    if (res.changes > 0) {
      writeAudit({ ownerId: owner, actor: 'owner', action: 'reset', entity: 'classification:exemplars' });
    }
    ctx.body = { ok: true, cleared: res.changes };
  });

  return router;
}
