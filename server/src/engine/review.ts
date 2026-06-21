/**
 * Nightly review + reschedule (PR-C+, Workstream B).
 *
 * A planned task block whose time has passed un-started is a *missed* task. The
 * `review_day` cron runs this once a day (01:00) and acts hybrid-by-priority:
 *   - **low priority (>= 3)** → auto-defer with a +1/3/7-day backoff (bump
 *     `scheduled_for`, increment `defer_count`, drop the stale planned block so
 *     it doesn't linger — the task re-surfaces on its new day);
 *   - **high priority (<= 2)** → mark `status='missed'` and leave it for the
 *     user to reschedule (the client's "Missed" review surface). No silent move.
 *
 * Why a cron and not lazy-on-read (unlike pattern placement): this is a
 * once-a-day judgment about the *past*, with side effects (a deferral that
 * shouldn't fire twice). There's nothing to derive on a read.
 */
import { sqlite } from '../db/index.js';
import { broadcast } from '../routes/sse.js';
import { localISODate } from '../lib/dates.js';

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
  deferred: number;   // low-priority, auto-rescheduled
  surfaced: number;   // high-priority, marked missed for user review
}

interface MissedRow {
  task_id: string;
  priority: number;
  defer_count: number;
}

/**
 * Review missed planned task blocks as of `nowISO` and act. Returns counts.
 * Idempotent in spirit: once a block is consumed (deferred → deleted, or
 * surfaced → task status 'missed'), it won't be re-counted on the next run.
 */
export function reviewAndReschedule(opts: { owner?: number; nowISO?: string } = {}): ReviewResult {
  const nowISO = opts.nowISO ?? new Date().toISOString();

  // Missed = a planned task block whose end has passed, whose task isn't done
  // and isn't already surfaced as missed. One row per task (earliest miss).
  const ownerClause = opts.owner != null ? `AND t.owner_id = @owner` : ``;
  const missed = sqlite
    .prepare(
      `SELECT t.id AS task_id, COALESCE(t.priority, 3) AS priority, COALESCE(t.defer_count, 0) AS defer_count
         FROM tasks t
        WHERE t.id IN (
                SELECT tb.task_id FROM time_blocks tb
                 WHERE tb.block_kind = 'task' AND tb.task_id IS NOT NULL
                   AND tb.status = 'planned' AND tb.end_at < @now
              )
          AND t.status NOT IN ('done','completed','cancelled','missed')
          ${ownerClause}
        GROUP BY t.id`
    )
    .all({ now: nowISO, owner: opts.owner }) as MissedRow[];

  const bumpDefer = sqlite.prepare(
    `UPDATE tasks SET scheduled_for = ?, defer_count = defer_count + 1, status = 'open' WHERE id = ?`
  );
  const dropBlocks = sqlite.prepare(
    `DELETE FROM time_blocks WHERE task_id = ? AND block_kind = 'task' AND status = 'planned' AND end_at < ?`
  );
  const markMissed = sqlite.prepare(`UPDATE tasks SET status = 'missed' WHERE id = ?`);
  const markBlocksMissed = sqlite.prepare(
    `UPDATE time_blocks SET status = 'missed' WHERE task_id = ? AND block_kind = 'task' AND status = 'planned' AND end_at < ?`
  );

  let deferred = 0;
  let surfaced = 0;
  const tx = sqlite.transaction(() => {
    for (const m of missed) {
      if (m.priority >= 3) {
        // Low priority → auto-defer with backoff; drop the stale block.
        bumpDefer.run(addDays(backoffDays(m.defer_count)), m.task_id);
        dropBlocks.run(m.task_id, nowISO);
        deferred++;
      } else {
        // High priority → surface for the user; don't move it silently.
        markMissed.run(m.task_id);
        markBlocksMissed.run(m.task_id, nowISO);
        surfaced++;
      }
    }
  });
  tx();

  return { missed: missed.length, deferred, surfaced };
}

/**
 * Reschedule a task `days` out from today (the user's +1/+3/+7 buttons on the
 * Missed surface, or any explicit reschedule). Clears the 'missed' status,
 * bumps scheduled_for + defer_count, and removes any stale missed/planned
 * blocks so it re-places cleanly on the new day.
 */
export function rescheduleTask(taskId: string, days: number): { scheduled_for: string } {
  const scheduledFor = addDays(Math.max(0, Math.round(days)));
  const tx = sqlite.transaction(() => {
    sqlite.prepare(`UPDATE tasks SET scheduled_for = ?, status = 'open', defer_count = defer_count + 1 WHERE id = ?`).run(scheduledFor, taskId);
    sqlite.prepare(`DELETE FROM time_blocks WHERE task_id = ? AND block_kind = 'task' AND status IN ('missed','planned')`).run(taskId);
  });
  tx();
  return { scheduled_for: scheduledFor };
}
