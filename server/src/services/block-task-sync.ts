/**
 * Block ⇄ Task scheduling sync.
 *
 * A task on the Planner IS scheduled, so its own scheduling-intent fields
 * (`scheduled_for`, `task_time`) must mirror the placement of its block, and editing
 * the task's time/day must move the placed block — the two stay in lockstep. The
 * BLOCK is the source of truth for placement; the TASK carries the user-facing intent.
 *
 * All cross-entity writes funnel through here (the single service the codebase was
 * missing), modelled on `services/timer.ts` which likewise writes both entities. Uses
 * raw `sqlite` (synchronous) so a write can't be interrupted mid-flight, and converts
 * instants through the owner's timezone — never the server zone — so a near-midnight
 * placement lands on the correct calendar day (DST included).
 */
import { sqlite } from '../db/index.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { localDateInTZ, utcToZonedWallTime, zonedWallTimeToUTC } from '../lib/tz.js';
import { syncTaskReminders } from '../engine/reminders.js';
import { stampRow } from '../sync/apply.js';

/**
 * TERMINAL time_block statuses — settled history the scheduling engine must never
 * delete or re-place: 'completed'/'skipped' are done outcomes, 'cancelled'/'missed'
 * are the review surface's evidence (Phase AE status-vocabulary alignment,
 * docs/AE-reflow-correctness.md). Every auto-clear / active-placement predicate
 * interpolates [[TERMINAL_BLOCK_STATUS_SQL]] instead of hand-writing the list, so
 * the clear paths can't drift apart (clearDayAutoBlocks once carried a narrower
 * copy and deleted the cancelled/missed evidence that reflow preserves).
 *
 * NB: distinct from the OBSTACLE predicate (scheduler.ts / extend-block.ts), which
 * deliberately keeps 'missed' — a missed block still occupies its past slot.
 */
export const TERMINAL_BLOCK_STATUSES = ['completed', 'skipped', 'cancelled', 'missed'] as const;
/** SQL list literal for `status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})`. */
export const TERMINAL_BLOCK_STATUS_SQL = TERMINAL_BLOCK_STATUSES.map((s) => `'${s}'`).join(',');

interface BlockRow {
  id: string;
  task_id: string | null;
  block_kind: string;
  start_at: string;
  end_at: string;
  all_day: number;
  is_locked: number;
  status: string;
}

function blockRow(id: string, ownerId: string): BlockRow | undefined {
  return sqlite
    .prepare(`SELECT id, task_id, block_kind, start_at, end_at, all_day, is_locked, status FROM time_blocks WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId) as BlockRow | undefined;
}

/**
 * Mirror a block's placement onto its linked task's `scheduled_for` + `task_time`.
 * No-op unless the block is a task placement (`block_kind='task'` with a `task_id`).
 *
 * One task can have several session blocks; only the **earliest-start** placement owns
 * the task's scheduling-intent fields, so dragging a later session never re-anchors the
 * task (or its reminders, which key off `scheduled_for`+`task_time`). An all-day block
 * clears `task_time` (it has no clock time). Returns the synced task id, or null.
 */
export function syncTaskFromBlock(blockId: string, ownerId: string): string | null {
  const block = blockRow(blockId, ownerId);
  if (!block || !block.task_id || block.block_kind !== 'task') return null;

  // Only the earliest placement of the task owns its scheduling fields.
  const earliest = sqlite
    .prepare(`SELECT MIN(start_at) AS s FROM time_blocks WHERE task_id = ? AND owner_id = ? AND block_kind = 'task'`)
    .get(block.task_id, ownerId) as { s: string | null } | undefined;
  if (earliest?.s && block.start_at > earliest.s) return null;

  const tz = ownerTimezone(ownerId);
  const scheduledFor = localDateInTZ(block.start_at, tz);
  const taskTime = block.all_day ? null : utcToZonedWallTime(block.start_at, tz);

  // For a recurring INSTANCE (occurrence_date set), keep occurrence_date aligned with
  // the new day too — otherwise reminders (which anchor on scheduled_for) and the
  // recurrence/streak logic (which keys on occurrence_date) would disagree and the
  // instance would be half-moved.
  const info = sqlite
    .prepare(
      `UPDATE tasks SET scheduled_for = ?, task_time = ?,
         occurrence_date = CASE WHEN occurrence_date IS NOT NULL THEN ? ELSE occurrence_date END
       WHERE id = ? AND owner_id = ?`,
    )
    .run(scheduledFor, taskTime, scheduledFor, block.task_id, ownerId);
  // The mirror image of the stamp in syncBlockFromTask. Every caller of this is an owner
  // block edit (moveBlockGroup / promoteBlockToScheduled / updateBlock / the extend route)
  // whose BLOCK side this PR stamps — leaving the task side unstamped would let a stale
  // queued task op drag scheduled_for/task_time back out of lockstep with the block.
  // (`occurrence_date` is outside the sync allowlist, so it needs no stamp.)
  if (info.changes > 0) stampRow(sqlite, 'task', block.task_id, ['scheduledFor', 'taskTime']);

  syncTaskReminders(ownerId, block.task_id);
  return block.task_id;
}

/**
 * Mirror a block's done-state onto its linked task: completing a placement completes
 * the task; reverting it reopens the task and clears its completion time. Keeps the
 * two status vocabularies reconciled server-side, so the client makes one call (no
 * non-atomic dual write). No-op unless the block is a task placement. Returns the
 * task id when a mirror was applied.
 */
export function mirrorBlockStatusToTask(blockId: string, ownerId: string): string | null {
  const block = blockRow(blockId, ownerId);
  if (!block || !block.task_id || block.block_kind !== 'task') return null;
  if (block.status === 'completed') {
    sqlite
      .prepare(`UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ? AND owner_id = ?`)
      .run(new Date().toISOString(), block.task_id, ownerId);
    stampRow(sqlite, 'task', block.task_id, ['status', 'completedAt']);
    // Re-derive reminders AFTER the status flip so a same-PATCH time+complete change
    // doesn't leave auto-reminders firing for a now-done task (syncTaskReminders
    // clears them for a done task).
    syncTaskReminders(ownerId, block.task_id);
    return block.task_id;
  }
  if (block.status === 'planned') {
    // Un-completing a still-placed task returns it to `scheduled` (it still owns a
    // block), not all the way back to the open backlog.
    sqlite
      .prepare(`UPDATE tasks SET status = 'scheduled', completed_at = NULL WHERE id = ? AND owner_id = ?`)
      .run(block.task_id, ownerId);
    stampRow(sqlite, 'task', block.task_id, ['status', 'completedAt']);
    syncTaskReminders(ownerId, block.task_id);
    return block.task_id;
  }
  if (block.status === 'skipped') {
    // Skipping a session settles the BLOCK but not the task's work. If that was the
    // task's last active placement, return the task to the open backlog instead of
    // leaving it 'scheduled' forever with nothing on the Planner.
    return revertTaskPlacementStatus(block.task_id, ownerId);
  }
  return null;
}

/**
 * The inverse of [[mirrorBlockStatusToTask]]: mirror a TASK's done-state onto its
 * calendar blocks, so checking a task off in the Tasks list settles its Planner
 * placement too (and un-checking revives it).
 *
 * - task `done`  → every still-active placement (`planned`/`overrun`/`in_progress`,
 *   the [[revertTaskPlacementStatus]] active triple) becomes `completed`. Locked
 *   pins included — completing settled work never deletes or moves anything.
 * - task not-done → its `completed` task-blocks return to `planned` (the symmetric
 *   inverse; a reopened task's work is un-done again).
 *
 * Reads the task's CURRENT status — call it after the status write, on a
 * done ⇄ not-done transition only. Returns the affected block ids so callers can
 * broadcast `block:updated`. Never touches other statuses (`skipped`/`cancelled`/
 * `missed` stay settled history).
 */
export function mirrorTaskStatusToBlocks(taskId: string, ownerId: string): string[] {
  const task = sqlite
    .prepare(`SELECT status FROM tasks WHERE id = ? AND owner_id = ?`)
    .get(taskId, ownerId) as { status: string } | undefined;
  if (!task) return [];
  const [fromList, to] =
    task.status === 'done'
      ? [`'planned','overrun','in_progress'`, 'completed']
      : [`'completed'`, 'planned'];
  const rows = sqlite
    .prepare(
      `SELECT id FROM time_blocks
        WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND status IN (${fromList})`,
    )
    .all(taskId, ownerId) as { id: string }[];
  if (rows.length === 0) return [];
  const update = sqlite.prepare(`UPDATE time_blocks SET status = ? WHERE id = ? AND owner_id = ?`);
  for (const { id } of rows) {
    update.run(to, id, ownerId);
    stampRow(sqlite, 'block', id, ['status']);
  }
  return rows.map((r) => r.id);
}

/**
 * Mirror an ENGINE-CHOSEN placement onto its task: set `scheduled_for` to the owner-
 * local day of the task's earliest still-active placement and flip open → scheduled.
 *
 * Unlike [[syncTaskFromBlock]] this NEVER writes `task_time`: a wall-clock time on the
 * task is reserved for USER-stated intent (wizard / quick-add / task PATCH). If engine
 * placement mirrored its chosen slot into `task_time`, the next Auto run's pin pass
 * (AD1) would read it back as a stated time and pin it as an is_auto=0 block — one
 * reflow cycle would freeze the whole day solid. `scheduled_for` is safe to mirror
 * (the pin pass keys on `task_time` alone).
 */
export function mirrorEnginePlacement(taskId: string, ownerId: string): string | null {
  const earliest = sqlite
    .prepare(
      `SELECT MIN(start_at) AS s FROM time_blocks
        WHERE task_id = ? AND owner_id = ? AND block_kind = 'task'
          AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})`,
    )
    .get(taskId, ownerId) as { s: string | null } | undefined;
  if (!earliest?.s) return null;
  const day = localDateInTZ(earliest.s, ownerTimezone(ownerId));
  // Keep occurrence_date aligned for a recurring instance, mirroring syncTaskFromBlock.
  sqlite
    .prepare(
      `UPDATE tasks SET scheduled_for = ?,
         occurrence_date = CASE WHEN occurrence_date IS NOT NULL THEN ? ELSE occurrence_date END
       WHERE id = ? AND owner_id = ? AND (scheduled_for IS NULL OR scheduled_for <> ?)`,
    )
    .run(day, day, taskId, ownerId, day);
  applyTaskPlacementStatus(taskId, ownerId);
  syncTaskReminders(ownerId, taskId);
  return taskId;
}

/**
 * Placing a task on the Planner IS scheduling it: flip an `open` task to
 * `scheduled` when it gains a task placement. No-op for habits (their occurrences
 * are managed on the planner, not via this status) and for any non-open status —
 * a placement never overrides done/cancelled/in_progress/deferred/etc. Returns the
 * task id when the status actually changed, else null.
 */
export function applyTaskPlacementStatus(taskId: string, ownerId: string): string | null {
  const task = sqlite
    .prepare(`SELECT status, subtype FROM tasks WHERE id = ? AND owner_id = ?`)
    .get(taskId, ownerId) as { status: string; subtype: string | null } | undefined;
  if (!task || task.subtype === 'habit' || task.status !== 'open') return null;
  sqlite.prepare(`UPDATE tasks SET status = 'scheduled' WHERE id = ? AND owner_id = ?`).run(taskId, ownerId);
  stampRow(sqlite, 'task', taskId, ['status']);
  return taskId;
}

/**
 * The inverse of [[applyTaskPlacementStatus]]: when a `scheduled` task no longer
 * has any active placement (no `block_kind='task'` block that is still planned or
 * overrunning), return it to the open backlog. A completed/skipped block doesn't
 * count as an active placement. Only ever touches a `scheduled` task — done,
 * cancelled, routine-derived, etc. are left alone. Returns the task id when the
 * status actually changed, else null.
 */
export function revertTaskPlacementStatus(taskId: string, ownerId: string): string | null {
  const task = sqlite
    .prepare(`SELECT status FROM tasks WHERE id = ? AND owner_id = ?`)
    .get(taskId, ownerId) as { status: string } | undefined;
  if (!task || task.status !== 'scheduled') return null;
  const active = sqlite
    .prepare(
      `SELECT 1 FROM time_blocks
        WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND status IN ('planned','overrun','in_progress') LIMIT 1`,
    )
    .get(taskId, ownerId);
  if (active) return null;
  sqlite.prepare(`UPDATE tasks SET status = 'open' WHERE id = ? AND owner_id = ?`).run(taskId, ownerId);
  stampRow(sqlite, 'task', taskId, ['status']);
  syncTaskReminders(ownerId, taskId);
  return taskId;
}

/**
 * The reverse direction: when a task's `scheduled_for` / `task_time` / `estimated_minutes`
 * is edited, move (and resize) its placed block to match — so editing the task keeps
 * its Planner placement in lockstep, not just the other way around.
 *
 * Operates on the task's earliest **planned** task block only (the common one-block
 * case); a locked or all-day block is left untouched. The block is marked manual
 * (`is_auto=0`) so a subsequent Auto replan won't reclaim/relocate it. Returns the
 * moved block id, or null when there's nothing to move / no change.
 */
export function syncBlockFromTask(taskId: string, ownerId: string, opts: { resizeToEstimate?: boolean } = {}): string | null {
  const task = sqlite
    .prepare(`SELECT id, scheduled_for, task_time, estimated_minutes FROM tasks WHERE id = ? AND owner_id = ?`)
    .get(taskId, ownerId) as
    | { id: string; scheduled_for: string | null; task_time: string | null; estimated_minutes: number | null }
    | undefined;
  if (!task) return null;

  const block = sqlite
    .prepare(
      `SELECT id, start_at, end_at, all_day, is_locked FROM time_blocks
       WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND status = 'planned'
       ORDER BY start_at ASC LIMIT 1`,
    )
    .get(taskId, ownerId) as { id: string; start_at: string; end_at: string; all_day: number; is_locked: number } | undefined;
  if (!block || block.all_day || block.is_locked) return null;

  const tz = ownerTimezone(ownerId);
  // Day from the task's scheduled_for, else the block's current local day; time from
  // the task's task_time, else the block's current local time-of-day.
  const day = task.scheduled_for ?? localDateInTZ(block.start_at, tz);
  const time = task.task_time ?? utcToZonedWallTime(block.start_at, tz);
  const newStart = zonedWallTimeToUTC(day, time, tz);
  // Resize to the estimate ONLY when the estimate was actually edited; otherwise
  // preserve the block's current span so a day/time edit never silently reverts a
  // manual block resize (the block span and task.estimated_minutes can legitimately
  // differ — a resize updates the span, not the estimate).
  const curDurMs = Date.parse(block.end_at) - Date.parse(block.start_at);
  const durMs = opts.resizeToEstimate && task.estimated_minutes ? task.estimated_minutes * 60_000 : curDurMs;
  const newEnd = new Date(Date.parse(newStart) + durMs).toISOString();

  if (newStart === block.start_at && newEnd === block.end_at) return null; // no change
  const info = sqlite
    .prepare(`UPDATE time_blocks SET start_at = ?, end_at = ?, is_auto = 0 WHERE id = ? AND owner_id = ?`)
    .run(newStart, newEnd, block.id, ownerId);
  // The task side of this mirror is stamped by updateTask, but the block side was not:
  // without it a queued block op with ANY older clientTs wins LWW (the compare is
  // `clientTs >= ''`) and snaps the block back, leaving block and task desynced — the one
  // invariant this module exists to hold. Gated on the owner-scoped UPDATE landing, since
  // stampRow keys on id alone. (`is_auto` is outside the sync allowlist, so it needs none.)
  if (info.changes > 0) stampRow(sqlite, 'block', block.id, ['startAt', 'endAt']);
  return block.id;
}

/**
 * Unschedule a task: drop its (non-locked) placed task-blocks. Called when a task's
 * start intent (`scheduled_for`) is CLEARED — the task returns to the backlog and leaves
 * the Planner. Locked blocks are preserved (an explicit user pin outranks the clear).
 * Returns the number of blocks removed (0 = nothing was placed / all locked).
 */
export function clearTaskPlacement(taskId: string, ownerId: string): number {
  return sqlite
    .prepare(
      `DELETE FROM time_blocks
        WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND is_locked = 0`,
    )
    .run(taskId, ownerId).changes;
}
