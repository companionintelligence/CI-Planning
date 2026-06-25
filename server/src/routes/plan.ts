import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { localISODate } from '../lib/dates.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { newId } from '../lib/ids.js';
import { broadcast } from './sse.js';
import { authorPlanOrder, parseInstruction, InstructError, type PlanPin } from '../agents/plan.js';
import { reflow, clearSuggestion, outstandingSuggestion } from '../engine/auto-defense.js';

/** Apply parsed time pins as locked, non-auto obstacle blocks the placer routes around. */
function applyPins(pins: PlanPin[]): number {
  if (pins.length === 0) return 0;
  const ins = sqlite.prepare(
    `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status)
     VALUES (?, ?, 'meeting', ?, ?, 1, 0, 'instruct', 'planned')`,
  );
  sqlite.transaction(() => { for (const p of pins) ins.run(newId(), p.title, p.start_at, p.end_at); })();
  return pins.length;
}

/**
 * Phase M B4 — the escalation accept/dismiss endpoints. These are the ONLY reactive
 * path that invokes the LLM: a big-disruption reflow surfaces a nudge (auto-defense),
 * and the day is re-authored solely when the user accepts here. Reflow stays LLM-free.
 */
export function planRouter() {
  const router = new Router();

  // POST /api/plan/instruct { text, date? } — §A4 (pins-first): parse a natural-language
  // instruction into a validated constraint set. Time pins are applied as locked obstacle
  // blocks the deterministic placer routes around; tag/ordering hints are parsed + returned
  // but not yet enforced. Pure-schema rubric: invalid ⇒ 422 (no writes); Ollama-down ⇒ 503.
  router.post('/api/plan/instruct', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { text?: string; date?: string };
    const text = (body.text ?? '').trim();
    if (!text) { ctx.status = 422; ctx.body = { error: 'text is required' }; return; }
    const date = body.date ?? localISODate();
    const owner = currentOwnerId();

    let result;
    try {
      result = await parseInstruction(owner, date, text); // validates fully BEFORE any write
    } catch (err) {
      if (err instanceof InstructError) {
        ctx.status = err.code === 'unavailable' ? 503 : 422;
        ctx.body = { error: err.message };
        return;
      }
      throw err;
    }

    const created = applyPins(result.pins); // only runs on a clean parse → no partial writes
    if (created > 0) broadcast(owner, 'block:created', { added: created });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'instruct', entity: `plan:${date}` });
    ctx.body = { ok: true, date, pins: result.pins, hints: result.hints, created };
  });

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
