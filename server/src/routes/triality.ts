import Router from '@koa/router';
import type Koa from 'koa';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { trialityEnabled } from '../lib/flags.js';
import { writeAudit } from '../lib/audit.js';
import { trialityNext, logShown, stampOutcome, isOutcome, type ScoredPick } from '../services/triality.js';

/**
 * Triality REST surface (design §8) — thin adapters over services/triality.ts;
 * zero business logic lives here. Every route 404s while the owner's
 * triality_enabled flag is off (the routes/calibration.ts posture: a disabled
 * feature's endpoints look absent, not broken — the client gates on the flag
 * it already has from GET /api/prefs, never by probing).
 *
 * GET /next is read-only and writes NO audit rows (WHO rule) — but it DOES
 * append `shown` rows to triality_log: a shown suggestion is an event in the
 * learning corpus, not a cache (two GETs = two sets of rows, by design).
 */
export function trialityRouter() {
  const router = new Router({ prefix: '/api/triality' });

  // Per-route gate (NOT router.use — the @koa/router prefix-path caveat, see
  // routes/calibration.ts).
  const gate = (ctx: Koa.Context): boolean => {
    if (trialityEnabled(currentOwnerId())) return true;
    ctx.status = 404;
    ctx.body = { error: 'Not found' };
    return false;
  };

  const pickToApi = (p: ScoredPick, logId: string | null) => ({
    slot: p.slot,
    action_kind: p.kind,
    action_ref: p.ref,
    title: p.title,
    estimate_min: p.estimateMin,
    direction: p.direction,
    categories: p.categories,
    motivation: p.motivation,
    scores: p.scores,
    ternary: p.ternary,
    log_id: logId,
  });

  // GET /api/triality/next — the three candidates with full per-component score
  // breakdowns + the situation vector actually used (the arithmetic IS the
  // explanation, §8). Refusal is a typed 200, not an error: "not enough history"
  // is an honest answer, not a failure.
  router.get('/next', async (ctx) => {
    if (!gate(ctx)) return;
    const owner = currentOwnerId();
    const now = new Date();
    const res = await trialityNext(owner, now);
    if (res.refused) {
      ctx.body = { refused: res.refused, have: res.have, need: res.need };
      return;
    }
    const logIds = logShown(owner, now, res.picks);
    ctx.body = {
      picks: res.picks.map((p, i) => (p ? pickToApi(p, logIds[i]) : null)),
      empty_reasons: res.emptyReasons,
      vector: res.vector,
      computed_at: now.toISOString(),
    };
  });

  // POST /api/triality/feedback { log_id, outcome } — stamp opened|staged|dismissed
  // on a shown row, at most once (append-only discipline; the engine's guarded
  // UPDATE). A foreign/unknown log_id is a 404 — multi-tenant convention: never
  // confirm another owner's row exists.
  router.post('/feedback', (ctx) => {
    if (!gate(ctx)) return;
    const body = (ctx.request.body ?? {}) as { log_id?: unknown; outcome?: unknown };
    if (typeof body.log_id !== 'string' || !body.log_id || !isOutcome(body.outcome)) {
      ctx.status = 422;
      ctx.body = { error: "feedback needs { log_id, outcome: 'opened' | 'staged' | 'dismissed' }" };
      return;
    }
    const owner = currentOwnerId();
    const mine = sqlite
      .prepare(`SELECT 1 FROM triality_log WHERE id = ? AND owner_id = ?`)
      .get(body.log_id, owner);
    if (!mine) {
      ctx.status = 404;
      ctx.body = { error: 'Not found' };
      return;
    }
    const res = stampOutcome(owner, body.log_id, body.outcome, new Date());
    // Audit only the stamp that actually landed — a repeat is a no-op, not a mutation.
    if (res.changed) {
      writeAudit({ ownerId: owner, actor: 'owner', action: 'feedback', entity: `triality:${body.log_id}` });
    }
    ctx.body = { changed: res.changed };
  });

  return router;
}
