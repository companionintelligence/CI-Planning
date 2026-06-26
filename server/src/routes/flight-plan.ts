import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { runAuto, fillByPriority, undoLastAuto, fillFlightPlanCandidates, placeFlightPlan, resolveTrustPolicy } from '../engine/autoplan.js';
import { authorPlanOrder } from '../agents/plan.js';
import { localISODate } from '../lib/dates.js';
import { writeAudit } from '../lib/audit.js';

/** Clamp a planning-horizon day count to a sane 1..60. */
const clampDays = (n: unknown): number => Math.max(1, Math.min(60, Math.floor(Number(n) || 1)));
/** 'YYYY-MM-DD' + n days, computed in UTC (date-only, DST-safe). */
function addDaysISO(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The flight-plan (Phase G, G4): a persisted, owner-scoped staging area + the
 * two-step Auto over it. Staging a pattern stages its member tasks; Reset clears it.
 */

interface FpRow {
  task_id: string;
  selected: number;
  position: number;
  source_pattern_id: string | null;
  added_at: string;
  title: string;
  priority: number | null;
  estimated_minutes: number | null;
  status: string;
  recurrence_rule: string | null;
}

function list(owner: string) {
  const rows = sqlite
    .prepare(
      `SELECT fp.task_id, fp.selected, fp.position, fp.source_pattern_id, fp.added_at,
              t.title, t.priority, t.estimated_minutes, t.status, t.recurrence_rule
         FROM flight_plan fp JOIN tasks t ON t.id = fp.task_id
        WHERE fp.owner_id = ? ORDER BY fp.position, fp.task_id`
    )
    .all(owner) as FpRow[];
  return rows.map((r) => ({ ...r, selected: !!r.selected, is_recurring: !!r.recurrence_rule }));
}

function nextPos(owner: string): number {
  return (sqlite.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get(owner) as { m: number }).m + 1;
}

export function flightPlanRouter() {
  const router = new Router();

  router.get('/api/flight-plan', async (ctx) => {
    ctx.body = { flight_plan: list(currentOwnerId()) };
  });

  // Add a task, or a whole pattern's member tasks (tagged with their source pattern).
  router.post('/api/flight-plan', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { task_id?: number; pattern_id?: number };
    const ins = sqlite.prepare(
      `INSERT OR IGNORE INTO flight_plan (owner_id, task_id, source_pattern_id, selected, position) VALUES (?, ?, ?, 1, ?)`
    );
    let added = 0;
    if (body.pattern_id != null) {
      const owns = sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(body.pattern_id, owner);
      if (!owns) { ctx.status = 404; ctx.body = { error: 'pattern not found' }; return; }
      const members = sqlite.prepare(`SELECT task_id FROM pattern_tasks WHERE pattern_id = ? ORDER BY position`).all(body.pattern_id) as { task_id: string }[];
      let pos = nextPos(owner);
      for (const m of members) if (ins.run(owner, m.task_id, body.pattern_id, pos++).changes > 0) added++;
    } else if (body.task_id != null) {
      const t = sqlite.prepare(`SELECT recurrence_parent_id FROM tasks WHERE id = ? AND owner_id = ?`).get(body.task_id, owner) as { recurrence_parent_id: string | null } | undefined;
      if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return; }
      if (t.recurrence_parent_id) { ctx.status = 422; ctx.body = { error: 'stage the series template, not an instance' }; return; }
      if (ins.run(owner, body.task_id, null, nextPos(owner)).changes > 0) added++;
    } else {
      ctx.status = 422; ctx.body = { error: 'task_id or pattern_id is required' }; return;
    }
    broadcast(owner, 'flight_plan:updated', { added });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'stage', entity: 'flight-plan:stage' });
    ctx.status = 201;
    ctx.body = { flight_plan: list(owner), added };
  });

  router.patch('/api/flight-plan/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    const taskId = ctx.params.taskId;
    if (!sqlite.prepare(`SELECT 1 FROM flight_plan WHERE owner_id = ? AND task_id = ?`).get(owner, taskId)) {
      ctx.status = 404; ctx.body = { error: 'not staged' }; return;
    }
    const body = (ctx.request.body ?? {}) as { selected?: boolean; position?: number };
    if (body.selected !== undefined) sqlite.prepare(`UPDATE flight_plan SET selected = ? WHERE owner_id = ? AND task_id = ?`).run(body.selected ? 1 : 0, owner, taskId);
    if (body.position !== undefined) sqlite.prepare(`UPDATE flight_plan SET position = ? WHERE owner_id = ? AND task_id = ?`).run(body.position, owner, taskId);
    broadcast(owner, 'flight_plan:updated', { task_id: taskId });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'toggle', entity: `flight-plan:${taskId}` });
    ctx.body = { flight_plan: list(owner) };
  });

  router.delete('/api/flight-plan/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    sqlite.prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`).run(owner, ctx.params.taskId);
    broadcast(owner, 'flight_plan:updated', { removed: ctx.params.taskId });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'remove', entity: `flight-plan:${ctx.params.taskId}` });
    ctx.body = { flight_plan: list(owner) };
  });

  // Clear the whole flight-plan (the Reset button).
  router.post('/api/flight-plan/reset', async (ctx) => {
    const owner = currentOwnerId();
    const r = sqlite.prepare(`DELETE FROM flight_plan WHERE owner_id = ?`).run(owner);
    broadcast(owner, 'flight_plan:reset', { cleared: r.changes });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'reset', entity: 'flight-plan:reset' });
    ctx.body = { ok: true, cleared: r.changes };
  });

  // Fill Flight Plan: propose open-task candidates into the staging area. Never places.
  router.post('/api/auto/fill', async (ctx) => {
    const owner = currentOwnerId();
    const added = fillFlightPlanCandidates(owner);
    broadcast(owner, 'flight_plan:filled', { added });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'fill', entity: 'flight-plan:fill' });
    ctx.body = { result: { step: 'fill', candidatesAdded: added }, flight_plan: list(owner) };
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
      ctx.body = { result: { step: 'place', blocksCreated, placed, unplaced, days }, flight_plan: list(owner) };
      return;
    }

    await authorPlanOrder(owner, date);
    const result = placeFlightPlan(owner, { blockId: body.block_id, date });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'run', entity: 'flight-plan:run' });
    ctx.body = { result, flight_plan: list(owner) };
  });

  // Explicit priority top-up (tap 3, D5): fill non-matching workday capacity with the
  // highest-priority still-unplaced tasks. Never silent — always an explicit tap.
  router.post('/api/auto/priority', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const result = fillByPriority(currentOwnerId(), { date: body.date });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'run', entity: 'flight-plan:priority' });
    ctx.body = { result, flight_plan: list(currentOwnerId()) };
  });

  // Undo the last placement run (req 2, D2): delete that run's blocks, re-stage its
  // tasks. One click, no confirmation; a second undo is a no-op.
  router.post('/api/auto/undo', async (ctx) => {
    const result = undoLastAuto(currentOwnerId());
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'undo', entity: 'flight-plan:undo' });
    ctx.body = { result, flight_plan: list(currentOwnerId()) };
  });

  return router;
}
