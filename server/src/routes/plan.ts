import Router from '@koa/router';
import { localISODate } from '../lib/dates.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { broadcast } from './sse.js';
import { authorPlanOrder } from '../agents/plan.js';
import { reflow, clearSuggestion, outstandingSuggestion } from '../engine/auto-defense.js';

/**
 * Phase M B4 — the escalation accept/dismiss endpoints. These are the ONLY reactive
 * path that invokes the LLM: a big-disruption reflow surfaces a nudge (auto-defense),
 * and the day is re-authored solely when the user accepts here. Reflow stays LLM-free.
 */
export function planRouter() {
  const router = new Router();

  // GET /api/plan/suggestion — the owner's outstanding re-plan nudge (or null).
  // The banner fetches this on mount so a reload re-surfaces a still-open suggestion
  // (the SSE 'replan:suggested' event is fire-once and isn't replayed on reconnect).
  router.get('/api/plan/suggestion', async (ctx) => {
    ctx.body = { suggestion: outstandingSuggestion(currentOwnerId()) ?? null };
  });

  // POST /api/plan/reauthor { date? } — accept the nudge: force an AI re-author of the
  // day, then re-place deterministically. authorPlanOrder uses the LLM only when
  // planning_mode='smart' and Ollama is up; otherwise it falls back to the deterministic
  // order and never throws. Calling reflow() directly (not the reactive fireReplan path)
  // means this re-author can never itself raise another suggestion.
  router.post('/api/plan/reauthor', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const date = body.date ?? localISODate();
    const owner = currentOwnerId();
    await authorPlanOrder(owner, date, { force: true });
    clearSuggestion(owner);
    const diff = reflow(owner, date, 'reauthor');
    broadcast(owner, 'schedule:done', { reason: 'reauthor', ...diff });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'reauthor', entity: `plan:${date}` });
    ctx.body = { ok: true, date, ...diff };
  });

  // POST /api/plan/reauthor/dismiss { date? } — dismiss the nudge: drop the outstanding
  // suggestion so it won't re-surface until the NEXT big disruption.
  router.post('/api/plan/reauthor/dismiss', async (ctx) => {
    const owner = currentOwnerId();
    clearSuggestion(owner);
    broadcast(owner, 'replan:dismissed', {});
    writeAudit({ ownerId: owner, actor: 'owner', action: 'dismiss', entity: 'plan:reauthor' });
    ctx.body = { ok: true };
  });

  return router;
}
