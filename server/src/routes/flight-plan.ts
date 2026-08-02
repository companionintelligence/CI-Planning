import Router from '@koa/router';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { fillByPriority, undoLastAuto, canUndoLastAuto, fillFlightPlanCandidates } from '../engine/autoplan.js';
import { localISODate } from '../lib/dates.js';
import { writeAudit } from '../lib/audit.js'; // still used by the fill/priority/undo endpoints below
import { listFlightPlan, stage, updateEntry, unstageEntry, resetFlightPlan } from '../services/flight-plan.js';
import { autoRun } from '../services/engine-ops.js';

/**
 * The flight-plan (Phase G, G4): a persisted, owner-scoped staging area + the
 * two-step Auto over it. The staging CRUD lives in services/flight-plan.ts (Phase W · W5,
 * shared with GraphQL); these handlers are thin shells that fire the SSE broadcast the
 * service can't (transport-agnostic). The two-step Auto endpoints below call the engine
 * directly and are unchanged.
 */

export function flightPlanRouter() {
  const router = new Router();

  // `can_undo` rides this read so the Undo affordance survives a reload. Without it the
  // client's only signal was the return value of its OWN Schedule call, i.e. component
  // state — so a refresh hid the button while the run stayed fully undoable server-side.
  router.get('/api/flight-plan', async (ctx) => {
    const owner = currentOwnerId();
    ctx.body = { flight_plan: await listFlightPlan(owner), can_undo: canUndoLastAuto(owner) };
  });

  // Add a task, or a whole pattern's member tasks (tagged with their source pattern).
  router.post('/api/flight-plan', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { task_id?: number; pattern_id?: number };
    const res = await stage(owner, { taskId: body.task_id, patternId: body.pattern_id });
    if (!res.ok) {
      if (res.error === 'pattern_not_found') { ctx.status = 404; ctx.body = { error: 'pattern not found' }; return; }
      if (res.error === 'task_not_found') { ctx.status = 404; ctx.body = { error: 'task not found' }; return; }
      if (res.error === 'is_instance') { ctx.status = 422; ctx.body = { error: 'stage the series template, not an instance' }; return; }
      ctx.status = 422; ctx.body = { error: 'task_id or pattern_id is required' }; return;
    }
    broadcast(owner, 'flight_plan:updated', { added: res.added });
    ctx.status = 201;
    ctx.body = { flight_plan: await listFlightPlan(owner), added: res.added };
  });

  router.patch('/api/flight-plan/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    const taskId = ctx.params.taskId;
    const body = (ctx.request.body ?? {}) as { selected?: boolean; position?: number };
    const res = await updateEntry(owner, taskId, { selected: body.selected, position: body.position });
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not staged' }; return; }
    broadcast(owner, 'flight_plan:updated', { task_id: taskId });
    ctx.body = { flight_plan: await listFlightPlan(owner) };
  });

  router.delete('/api/flight-plan/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    await unstageEntry(owner, ctx.params.taskId);
    broadcast(owner, 'flight_plan:updated', { removed: ctx.params.taskId });
    ctx.body = { flight_plan: await listFlightPlan(owner) };
  });

  // Clear the whole flight-plan (the Reset button).
  router.post('/api/flight-plan/reset', async (ctx) => {
    const owner = currentOwnerId();
    const { cleared } = await resetFlightPlan(owner);
    broadcast(owner, 'flight_plan:reset', { cleared });
    ctx.body = { ok: true, cleared };
  });

  // Fill Flight Plan: propose open-task candidates into the staging area. Never places.
  // Honors an optional `date` so callers can stage a specific day's scheduled tasks (plus
  // the undated backlog); omitted ⇒ the owner's today (fillFlightPlanCandidates' default),
  // so no-date callers (e.g. Plan-my-week's fill({})) are unchanged.
  router.post('/api/auto/fill', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { date?: string };
    const added = fillFlightPlanCandidates(owner, { date: body.date });
    broadcast(owner, 'flight_plan:filled', { added });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'fill', entity: 'flight-plan:fill' });
    ctx.body = { result: { step: 'fill', candidatesAdded: added }, flight_plan: await listFlightPlan(owner) };
  });

  // Auto Schedule: place the selected staged items (tag-matched Plans → direction windows
  // → workday fallback ordered by fill_order). Authors the day's plan order once before
  // placing (no-op if already authored today; always falls back to deterministic if AI off).
  //
  // T-SCHED-2 — Hands-off planning horizon. In the Hands-off trust mode, Auto plans the
  // next N days starting at `date` instead of just that one day; in Cautious/Balanced it
  // stays single-day. An explicit body.horizon_days overrides; a specific-block placement
  // is always single-day. The horizon resolution + placement loop lives in
  // services/engine-ops.ts (shared with GraphQL; writeAudit fires inside it); the SSE
  // broadcast stays transport-side — one aggregated `auto:placed` on a multi-day run.
  router.post('/api/auto/run', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { block_id?: string; date?: string; horizon_days?: number; smart?: boolean };
    const date = body.date ?? localISODate();

    const result = await autoRun(owner, { date, blockId: body.block_id, horizonDays: body.horizon_days, smart: body.smart });

    // A multi-day run (result.days > 1) fires one aggregated event; single-day fires none
    // (byte-identical to before).
    if (result.days != null && result.days > 1) {
      broadcast(owner, 'auto:placed', { blocksCreated: result.blocksCreated, placed: result.placed, unplaced: result.unplaced, days: result.days });
      broadcast(owner, 'flight_plan:updated', { removed: result.placed });
    }
    ctx.body = { result, flight_plan: await listFlightPlan(owner) };
  });

  // Explicit priority top-up (tap 3, D5): fill non-matching workday capacity with the
  // highest-priority still-unplaced tasks. Never silent — always an explicit tap.
  router.post('/api/auto/priority', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const result = fillByPriority(currentOwnerId(), { date: body.date });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'run', entity: 'flight-plan:priority' });
    ctx.body = { result, flight_plan: await listFlightPlan(currentOwnerId()) };
  });

  // Undo the last placement run (req 2, D2): delete that run's blocks, re-stage its
  // tasks. One click, no confirmation; a second undo is a no-op.
  router.post('/api/auto/undo', async (ctx) => {
    const result = undoLastAuto(currentOwnerId());
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'undo', entity: 'flight-plan:undo' });
    ctx.body = { result, flight_plan: await listFlightPlan(currentOwnerId()) };
  });

  return router;
}
