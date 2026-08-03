/**
 * Review + reschedule (PR-C+, Workstream B; unified 2026-07-20).
 *
 * A planned task block whose time has passed un-started is a *missed* task.
 * EVERY priority now auto-defers with the +1/3/7-day backoff (bump
 * `scheduled_for`, increment `defer_count`, drop the stale block so it doesn't
 * linger — the task re-surfaces on its new day). The old hybrid — parking
 * high-priority tasks as `status='missed'` for a manual review — is retired
 * (owner ruling 2026-07-20): the Missed review surface arrived only in #409,
 * so years of P1/P2 tasks silently starved Fill/Auto in a black hole. The
 * daily_plan outcome stamp KEEPS the priority split ('missed' ≤2 / 'deferred'
 * ≥3) so the nightly aggregates still distinguish an important miss from a
 * routine slip. Stuck `status='missed'` one-off tasks (pre-ruling residue, or
 * anything that lands there in future) are swept back to `open` by the same
 * backoff each run.
 *
 * Trust dial: for owners in Schedule mode (`trust_mode='hands_off'`), each
 * deferred/revived task is immediately booked into the next available slot on
 * its new day via `placeStartAnchoredTask` (best-effort — a placement failure
 * never fails the sweep). Suggest-mode owners get the task back as `open` with
 * a dated `scheduled_for` only; nothing is placed without a Schedule run.
 *
 * Runs nightly (`review_day` cron, 01:00) AND on demand — the top-bar sweep
 * button posts `/api/review/sweep` (owner-scoped, same engine). Idempotent by
 * construction: outcome stamps are write-once, deferrals consume their stale
 * blocks, and the revive pass only sees rows still stuck in 'missed'.
 */
import { store } from '../db/store.js';
import { broadcast } from '../routes/sse.js';
import { localISODate } from '../lib/dates.js';
import { removeEntityTags } from '../services/tags.js';
import { stampRow } from '../sync/apply.js';
import { placeStartAnchoredTask, type StartAnchoredOutcome } from './autoplan.js';
import { logger } from '../lib/logger.js';

/** Backoff schedule by prior deferral count: 0→+1d, 1→+3d, 2+→+7d. */
export function backoffDays(deferCount: number): number {
  return [1, 3, 7][Math.min(deferCount, 2)];
}

/** Local YYYY-MM-DD `days` after today (server-local). */
function addDays(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return localISODate(d);
}

export interface ReviewResult {
  missed: number;     // tasks found past-due + un-started
  deferred: number;   // auto-rescheduled with backoff (all priorities now)
  revived: number;    // stuck status='missed' one-offs swept back to open
  placed: number;     // hands_off owners: deferred/revived tasks booked into a slot
  restaged: number;   // open tasks with no future blocks re-added to flight plan
}

interface MissedRow {
  task_id: string;
  owner_id: string;
  priority: number;
  defer_count: number;
}

/**
 * Review missed planned task blocks as of `nowISO` and act. Returns counts.
 * Idempotent in spirit: once a block is consumed (deferred → deleted), it won't
 * be re-counted on the next run; the revive pass only sees still-stuck rows.
 */
export async function reviewAndReschedule(opts: { owner?: string; nowISO?: string } = {}): Promise<ReviewResult> {
  const nowISO = opts.nowISO ?? new Date().toISOString();

  // Missed = a planned task block whose end has passed, whose task isn't done
  // and isn't already surfaced as missed. One row per task (earliest miss).
  const ownerClause = opts.owner != null ? `AND t.owner_id = @owner` : ``;
  const missed = await store()
    .prepare(
      `SELECT t.id AS task_id, t.owner_id, COALESCE(t.priority, 3) AS priority, COALESCE(t.defer_count, 0) AS defer_count
         FROM tasks t
        WHERE t.id IN (
                SELECT tb.task_id FROM time_blocks tb
                 WHERE tb.block_kind = 'task' AND tb.task_id IS NOT NULL
                   AND tb.status = 'planned' AND tb.end_at < @now
                   AND tb.is_locked = 0
              )
          AND t.status NOT IN ('done','completed','cancelled','missed')
          ${ownerClause}
        GROUP BY t.id`
    )
    .all<MissedRow>({ now: nowISO, owner: opts.owner });

  // Stuck 'missed' one-offs — pre-unification residue (or a sync'd write): swept
  // back to open by the same backoff. Recurring INSTANCES stay missed (genuine
  // history — recurrence-generate marks them itself); subtasks ride their parent.
  const stuck = await store()
    .prepare(
      `SELECT t.id AS task_id, t.owner_id, COALESCE(t.priority, 3) AS priority, COALESCE(t.defer_count, 0) AS defer_count
         FROM tasks t
        WHERE t.status = 'missed'
          AND t.recurrence_parent_id IS NULL
          AND t.parent_id IS NULL
          ${ownerClause}`
    )
    .all<MissedRow>({ owner: opts.owner });

  const bumpDefer = store().prepare(
    `UPDATE tasks SET scheduled_for = ?, defer_count = defer_count + 1, status = 'open' WHERE id = ?`
  );
  // is_locked = 0: a user-PINNED past block is a deliberate placement, not missed work
  // the review may destroy/relabel. It's also excluded from the missed-detection query
  // above, so a task pinned-but-not-done never triggers an endless nightly re-defer.
  // status IN ('missed','planned'): a revived task's blocks were relabelled 'missed'
  // by the old surface path — both flavors are stale and must go so it re-places clean.
  const dropBlocks = store().prepare(
    `DELETE FROM time_blocks WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND status IN ('missed','planned') AND end_at < ? AND is_locked = 0 RETURNING id`
  );
  // N4 lossy-slip fix: stamp daily_plan.outcome before block hard-delete so the
  // nightly aggregate can record planned-vs-done even after the block is gone.
  // Write-once (outcome IS NULL guard) so re-runs can't overwrite a prior stamp.
  // The stamp KEEPS the priority split — an important miss records 'missed' even
  // though the task itself now auto-defers like everything else.
  const stampPlanOutcome = store().prepare(
    `UPDATE daily_plan SET outcome = ? WHERE owner_id = ? AND task_id = ? AND outcome IS NULL`
  );

  let deferred = 0;
  let revived = 0;
  const moved: MissedRow[] = []; // everything reopened this run, for the placement pass
  await store().transaction(async () => {
    for (const m of missed) {
      // Auto-defer with backoff — ALL priorities; drop the stale block.
      await stampPlanOutcome.run(m.priority <= 2 ? 'missed' : 'deferred', m.owner_id, m.task_id);
      await bumpDefer.run(addDays(backoffDays(m.defer_count)), m.task_id);
      // CON-3 cascade: dropped blocks are HARD-deleted — clear their tag rows.
      for (const b of await dropBlocks.all<{ id: string }>(m.task_id, m.owner_id, nowISO)) await removeEntityTags('time_block', b.id);
      deferred++;
      moved.push(m);
    }
    for (const m of stuck) {
      // Same backoff for the stuck rows; their plan outcome (if any) was already
      // stamped 'missed' when they were surfaced — the write-once guard holds.
      await bumpDefer.run(addDays(backoffDays(m.defer_count)), m.task_id);
      for (const b of await dropBlocks.all<{ id: string }>(m.task_id, m.owner_id, nowISO)) await removeEntityTags('time_block', b.id);
      revived++;
      moved.push(m);
    }
  });

  // Schedule-mode placement: hands_off owners get each reopened task booked into
  // the next available slot on its new day right away (start-anchored engine —
  // R3 now-clamp, dedup, R2 status parity, broadcasts auto:placed). Best-effort:
  // a full day or an engine error never fails the sweep; the task stays open+dated.
  let placed = 0;
  if (moved.length > 0) {
    const trustOf = store().prepare(`SELECT trust_mode FROM scheduling_prefs WHERE owner_id = ?`);
    const trustCache = new Map<string, string>();
    for (const m of moved) {
      let trust = trustCache.get(m.owner_id);
      if (trust === undefined) {
        trust = (await trustOf.get<{ trust_mode: string }>(m.owner_id))?.trust_mode ?? 'balanced';
        trustCache.set(m.owner_id, trust);
      }
      if (trust !== 'hands_off') continue;
      try {
        const outcome: StartAnchoredOutcome = await placeStartAnchoredTask(m.owner_id, m.task_id);
        if (outcome.placed) placed++;
      } catch (err) {
        logger.warn('review sweep: start-anchored placement failed', { owner: m.owner_id, taskId: m.task_id, err: (err as Error).message });
      }
    }
  }

  // Re-stage open tasks that have no future blocks and aren't already in the
  // flight plan, so the user sees them again at the start of the new day.
  const ownerFilterClause = opts.owner != null ? `AND t.owner_id = @owner` : '';
  const toRestage = await store()
    .prepare(
      `SELECT t.id AS task_id, t.owner_id
         FROM tasks t
        WHERE t.status = 'open'
          AND COALESCE(t.subtype, 'standard') != 'habit'
          AND t.parent_id IS NULL
          AND t.recurrence_parent_id IS NULL
          AND (t.scheduled_for IS NULL OR t.scheduled_for <= date(@now))
          AND NOT EXISTS (
            SELECT 1 FROM time_blocks tb
            WHERE tb.task_id = t.id AND tb.owner_id = t.owner_id AND tb.block_kind = 'task' AND tb.start_at > @now
          )
          AND NOT EXISTS (
            SELECT 1 FROM flight_plan fp
            WHERE fp.task_id = t.id AND fp.owner_id = t.owner_id
          )
          ${ownerFilterClause}`
    )
    .all<{ task_id: string; owner_id: string }>({ now: nowISO, owner: opts.owner });

  const byOwner = new Map<string, string[]>();
  for (const row of toRestage) {
    const arr = byOwner.get(row.owner_id) ?? [];
    arr.push(row.task_id);
    byOwner.set(row.owner_id, arr);
  }

  const getMax = store().prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`);
  const ins = store().prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`);
  let restaged = 0;
  for (const [ownerId, taskIds] of byOwner) {
    let pos = (await getMax.get<{ m: number }>(ownerId))!.m + 1;
    for (const taskId of taskIds) {
      if ((await ins.run(ownerId, taskId, pos)).changes > 0) { pos++; restaged++; }
    }
    broadcast(ownerId, 'flight_plan:updated', { restaged: taskIds.length });
  }

  return { missed: missed.length, deferred, revived, placed, restaged };
}

/**
 * Reschedule a task `days` out from today (the user's +1/+3/+7 buttons on the
 * Missed surface, or any explicit reschedule). Clears the 'missed' status,
 * bumps scheduled_for + defer_count, and removes any stale missed/planned
 * blocks so it re-places cleanly on the new day.
 *
 * is_locked = 0: a user-PINNED placement survives the reschedule — the task's intent
 * moves to the new day, but a deliberate pin is never silently destroyed (it stays put
 * for the user to move or unpin themselves).
 *
 * Despite living beside the nightly sweep, this is an OWNER action with a single caller
 * (`routes/tasks.ts`) — never the cron, which does its own inline defer/mark. So it stamps
 * like any other online edit: `scheduled_for` and `status` are both mergeable and unpinned,
 * and without the server clock a queued op holding the old day would win LWW and drag the
 * task back. (`defer_count` isn't in the sync allowlist, so it needs no stamp.)
 *
 * The stamp is gated on the owner-scoped UPDATE landing, for the reason spelled out on
 * `cascadeArchiveToDescendants`: `stampRow` keys on `id` alone, so stamping a foreign row
 * would corrupt that owner's merge state. The route pre-checks ownership, but this stays
 * correct if a future caller does not.
 */
export async function rescheduleTask(taskId: string, days: number, owner: string): Promise<{ scheduled_for: string; placement?: StartAnchoredOutcome }> {
  const scheduledFor = addDays(Math.max(0, Math.round(days)));
  await store().transaction(async () => {
    const info = await store().prepare(`UPDATE tasks SET scheduled_for = ?, status = 'open', defer_count = defer_count + 1 WHERE id = ? AND owner_id = ?`).run(scheduledFor, taskId, owner);
    if (info.changes > 0) await stampRow('task', taskId, ['scheduledFor', 'status']);
    // CON-3 cascade: these blocks are HARD-deleted — clear their tag rows.
    for (const b of await store().prepare(`DELETE FROM time_blocks WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND status IN ('missed','planned') AND is_locked = 0 RETURNING id`).all<{ id: string }>(taskId, owner)) {
      await removeEntityTags('time_block', b.id);
    }
  });

  // Schedule mode only (trust_mode='hands_off'): book the reopened task into the
  // next available slot on its new day right away. Suggest/cautious owners keep
  // control — the task comes back open+dated and waits for a Schedule run.
  // Best-effort: a placement failure never fails the reschedule itself.
  let placement: StartAnchoredOutcome | undefined;
  const trust = (await store().prepare(`SELECT trust_mode FROM scheduling_prefs WHERE owner_id = ?`).get<{ trust_mode: string }>(owner))?.trust_mode;
  if (trust === 'hands_off') {
    try {
      placement = await placeStartAnchoredTask(owner, taskId);
    } catch (err) {
      logger.warn('rescheduleTask: start-anchored placement failed', { owner, taskId, err: (err as Error).message });
    }
  }
  return { scheduled_for: scheduledFor, placement };
}
