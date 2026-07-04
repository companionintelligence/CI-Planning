import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { runAuto, fillByPriority, undoLastAuto, fillFlightPlanCandidates, placeFlightPlan, resolveTrustPolicy } from '../engine/autoplan.js';
import { authorPlanOrder } from '../agents/plan.js';
import { localISODate } from '../lib/dates.js';
import { writeAudit } from '../lib/audit.js'; // still used by the Auto endpoints below
import { listFlightPlan, stage, updateEntry, unstageEntry, resetFlightPlan } from '../services/flight-plan.js';

/** Clamp a planning-horizon day count to a sane 1..60. */
const clampDays = (n: unknown): number => Math.max(1, Math.min(60, Math.floor(Number(n) || 1)));
/** 'YYYY-MM-DD' + n days, computed in UTC (date-only, DST-safe). */
function addDaysISO(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The flight-plan (Phase G, G4): a persisted, owner-scoped staging area + the
 * two-step Auto over it. The staging CRUD lives in services/flight-plan.ts (Phase W · W5,
 * shared with GraphQL); these handlers are thin shells that fire the SSE broadcast the
 * service can't (transport-agnostic). The two-step Auto endpoints below call the engine
 * directly and are unchanged.
 */

export function flightPlanRouter() {
  const router = new Router();

  router.get('/api/flight-plan', async (ctx) => {
    ctx.body = { flight_plan: listFlightPlan(currentOwnerId()) };
  });

  // Add a task, or a whole pattern's member tasks (tagged with their source pattern).
  router.post('/api/flight-plan', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { task_id?: number; pattern_id?: number };
    const res = stage(owner, { taskId: body.task_id, patternId: body.pattern_id });
    if (!res.ok) {
      if (res.error === 'pattern_not_found') { ctx.status = 404; ctx.body = { error: 'pattern not found' }; return; }
      if (res.error === 'task_not_found') { ctx.status = 404; ctx.body = { error: 'task not found' }; return; }
      if (res.error === 'is_instance') { ctx.status = 422; ctx.body = { error: 'stage the series template, not an instance' }; return; }
      ctx.status = 422; ctx.body = { error: 'task_id or pattern_id is required' }; return;
    }
    broadcast(owner, 'flight_plan:updated', { added: res.added });
    ctx.status = 201;
    ctx.body = { flight_plan: listFlightPlan(owner), added: res.added };
  });

  router.patch('/api/flight-plan/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    const taskId = ctx.params.taskId;
    const body = (ctx.request.body ?? {}) as { selected?: boolean; position?: number };
    const res = updateEntry(owner, taskId, { selected: body.selected, position: body.position });
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not staged' }; return; }
    broadcast(owner, 'flight_plan:updated', { task_id: taskId });
    ctx.body = { flight_plan: listFlightPlan(owner) };
  });

  router.delete('/api/flight-plan/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    unstageEntry(owner, ctx.params.taskId);
    broadcast(owner, 'flight_plan:updated', { removed: ctx.params.taskId });
    ctx.body = { flight_plan: listFlightPlan(owner) };
  });

  // Clear the whole flight-plan (the Reset button).
  router.post('/api/flight-plan/reset', async (ctx) => {
    const owner = currentOwnerId();
    const { cleared } = resetFlightPlan(owner);
    broadcast(owner, 'flight_plan:reset', { cleared });
    ctx.body = { ok: true, cleared };
  });

  // Fill Flight Plan: propose open-task candidates into the staging area. Never places.
  router.post('/api/auto/fill', async (ctx) => {
    const owner = currentOwnerId();
    const added = fillFlightPlanCandidates(owner);
    broadcast(owner, 'flight_plan:filled', { added });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'fill', entity: 'flight-plan:fill' });
    ctx.body = { result: { step: 'fill', candidatesAdded: added }, flight_plan: listFlightPlan(owner) };
  });

  // Auto Schedule: place the selected staged items (tag-matched Plans → direction windows
  // → workday fallback ordered by fill_order). Authors the day's plan order once before
  // placing (no-op if already authored today; always falls back to deterministic if AI off).
  router.post('/api/auto/run', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { block_id?: string; date?: string; horizon_days?: number };
    const date = body.date ?? localISODate();

    // T-SCHED-2 — Hands-off planning horizon. In the Hands-off trust mode, Auto plans the
    // next N days starting at `date` instead of just that one day; in Cautious/Balanced it
    // stays single-day (byte-identical to before). The count reuses
    // scheduling_prefs.planning_horizon_days — the SAME pref that governs the task
    // candidate-selection window, so "pulled in because due within N days" == "placed
    // across those N days" (intentional layering, no new column). An explicit
    // body.horizon_days overrides; a specific-block placement is always single-day.
    // (TM-4: the gate moved from the legacy auto_mode='schedule' to trust_mode='hands_off'.)
    const sched = sqlite
      .prepare(`SELECT planning_horizon_days FROM scheduling_prefs WHERE owner_id = ?`)
      .get(owner) as { planning_horizon_days?: number } | undefined;
    const days = body.block_id != null
      ? 1
      : body.horizon_days != null
        ? clampDays(body.horizon_days)
        : (resolveTrustPolicy(owner).mode === 'hands_off' ? clampDays(sched?.planning_horizon_days ?? 7) : 1);

    if (days > 1) {
      // Bounded loop over the EXISTING single-day placement — no new placement
      // semantics. placeFlightPlan clears each day's prior auto blocks first (idempotent
      // per day) and DELETEs placed tasks from staging, so leftovers naturally fan onto
      // the next day. `silent` suppresses per-day SSE; one aggregated event fires after.
      let blocksCreated = 0, placed = 0, unplaced = 0;
      for (let d = 0; d < days; d++) {
        const day = addDaysISO(date, d);
        // Day 0 authors normally (LLM when smart); future days author deterministically
        // so a multi-day plan never fires one LLM call per day.
        await authorPlanOrder(owner, day, d === 0 ? {} : { deterministic: true });
        const r = placeFlightPlan(owner, { date: day, silent: true });
        blocksCreated += r.blocksCreated ?? 0;
        placed += r.placed ?? 0;
        unplaced = r.unplaced ?? 0; // tasks still staged after the final day
      }
      broadcast(owner, 'auto:placed', { blocksCreated, placed, unplaced, days });
      broadcast(owner, 'flight_plan:updated', { removed: placed });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'run', entity: `flight-plan:run:${days}d` });
      ctx.body = { result: { step: 'place', blocksCreated, placed, unplaced, days }, flight_plan: listFlightPlan(owner) };
      return;
    }

    await authorPlanOrder(owner, date);
    const result = placeFlightPlan(owner, { blockId: body.block_id, date });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'run', entity: 'flight-plan:run' });
    ctx.body = { result, flight_plan: listFlightPlan(owner) };
  });

  // Explicit priority top-up (tap 3, D5): fill non-matching workday capacity with the
  // highest-priority still-unplaced tasks. Never silent — always an explicit tap.
  router.post('/api/auto/priority', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const result = fillByPriority(currentOwnerId(), { date: body.date });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'run', entity: 'flight-plan:priority' });
    ctx.body = { result, flight_plan: listFlightPlan(currentOwnerId()) };
  });

  // Undo the last placement run (req 2, D2): delete that run's blocks, re-stage its
  // tasks. One click, no confirmation; a second undo is a no-op.
  router.post('/api/auto/undo', async (ctx) => {
    const result = undoLastAuto(currentOwnerId());
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'undo', entity: 'flight-plan:undo' });
    ctx.body = { result, flight_plan: listFlightPlan(currentOwnerId()) };
  });

  return router;
}
