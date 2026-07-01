/**
 * Task → Objective auto-promotion.
 *
 * A task that gains subtasks is a small strategic unit, so it is surfaced in the
 * Phase N objectives tree: the parent task becomes a leaf **objective** (title
 * copied) and the parent + its non-ephemeral subtasks are linked via `objective_tasks`.
 * The task list shows the 8-pointed star for any task with an objective link.
 *
 * Ownership is tracked by `objectives.source_task_id` (migration 0086), which makes
 * promotion:
 *   - idempotent per task — reuse only THIS task's objective, never an unrelated one
 *     the parent was manually linked to;
 *   - a guaranteed leaf — a promoted objective only ever holds tasks;
 *   - garbage-collectable — [[unpromoteIfEmpty]] / [[dropSourceObjective]] remove it
 *     when its subtasks or parent go away (so childless auto-objectives don't pile up),
 *     but only while it's still *pristine* (top-level, no sub-objectives) — once the
 *     user organizes it under a project/goal it becomes theirs and is left alone.
 *
 * Uses raw synchronous `sqlite` (mirrors routes/objectives.ts).
 */
import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { broadcast } from '../routes/sse.js';
import { recomputeProgress, linkObjectiveTask } from '../routes/objectives.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';

/** Active (non-ephemeral, non-cancelled) subtasks of a parent — the objective's work.
 * Excludes `quick` ritual-local tasks and materialized recurrence instances, which
 * shouldn't pollute the strategic layer or its progress rollups. */
function linkableSubtaskIds(parentTaskId: string, ownerId: string): string[] {
  return (sqlite
    .prepare(
      `SELECT id FROM tasks
        WHERE parent_id = ? AND owner_id = ? AND status != 'cancelled'
          AND subtype != 'quick' AND recurrence_parent_id IS NULL`,
    )
    .all(parentTaskId, ownerId) as { id: string }[]).map((r) => r.id);
}

/**
 * Ensure the parent task (which just gained a subtask) is promoted to its own leaf
 * objective, and that the parent + its current linkable subtasks are linked to it.
 * Returns the objective id, or null if the parent doesn't exist / isn't linkable.
 */
export function ensureTaskPromoted(parentTaskId: string, ownerId: string): string | null {
  const parent = sqlite
    .prepare(`SELECT id, title, subtype, recurrence_parent_id FROM tasks WHERE id = ? AND owner_id = ?`)
    .get(parentTaskId, ownerId) as { id: string; title: string; subtype: string | null; recurrence_parent_id: string | null } | undefined;
  // Don't promote ephemeral parents (a quick task or a recurrence instance shouldn't
  // spawn a strategic objective).
  if (!parent || parent.subtype === 'quick' || parent.recurrence_parent_id) return null;

  // Find-or-create THIS task's objective (keyed on source_task_id, not "any link").
  const existing = sqlite
    .prepare(`SELECT id FROM objectives WHERE source_task_id = ? AND owner_id = ?`)
    .get(parentTaskId, ownerId) as { id: string } | undefined;

  let objId: string;
  let created = false;
  if (existing) {
    objId = existing.id;
  } else {
    objId = newId();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO objectives
           (id, owner_id, parent_id, title, description, horizon, status, cadence,
            target_date, category_id, priority, created_at, updated_at, level, source_task_id)
         VALUES (?, ?, NULL, ?, NULL, 'none', 'active', 'none', NULL, NULL, 3, ?, ?, 'objective', ?)`,
      )
      .run(objId, ownerId, parent.title, now, now, parentTaskId);
    // Sync: stamp the created objective's fields so an older queued op can't clobber them.
    stampRow(sqlite, 'objective', objId, ['title', 'status', 'horizon', 'cadence', 'priority']);
    created = true;
  }

  // Link the parent + its linkable subtasks (idempotent). Each link is a
  // sync-versioned join row (0087). The objective stays a leaf, so this never
  // violates the "tasks only on leaves" containment rule.
  const linkedTaskIds = [parentTaskId, ...linkableSubtaskIds(parentTaskId, ownerId)];
  const linkIds = linkedTaskIds.map((tid) => linkObjectiveTask(objId, tid));

  recomputeProgress(objId);
  broadcast(ownerId, created ? 'objective:created' : 'objective:updated', { id: objId });
  for (const linkId of linkIds) broadcast(ownerId, 'objective_task:updated', { id: linkId });
  for (const tid of linkedTaskIds) broadcast(ownerId, 'task:updated', { id: tid });
  writeAudit({ ownerId, actor: 'owner', action: created ? 'create' : 'link', entity: `objective:${objId}` });
  return objId;
}

/** A promoted objective is "pristine" (safe to auto-GC) only while it's still a
 * top-level leaf the user hasn't organized into their hierarchy. */
function isPristine(objId: string): boolean {
  const row = sqlite.prepare(`SELECT parent_id FROM objectives WHERE id = ?`).get(objId) as { parent_id: string | null } | undefined;
  if (!row || row.parent_id != null) return false;
  const child = sqlite.prepare(`SELECT 1 FROM objectives WHERE parent_id = ? LIMIT 1`).get(objId);
  return !child;
}

/**
 * Un-promote: when a parent task has no active subtasks left, delete its pristine
 * auto-created objective so childless single-task objectives don't accumulate. No-op
 * if the objective was organized under a project/goal (then it's the user's to keep).
 */
export function unpromoteIfEmpty(parentTaskId: string, ownerId: string): void {
  const obj = sqlite
    .prepare(`SELECT id FROM objectives WHERE source_task_id = ? AND owner_id = ?`)
    .get(parentTaskId, ownerId) as { id: string } | undefined;
  if (!obj) return;
  const activeSubs = (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND owner_id = ? AND status != 'cancelled' AND subtype != 'quick' AND recurrence_parent_id IS NULL`)
    .get(parentTaskId, ownerId) as { n: number }).n;
  if (activeSubs > 0 || !isPristine(obj.id)) return;
  sqlite.prepare(`DELETE FROM objectives WHERE id = ?`).run(obj.id); // cascades objective_tasks
  broadcast(ownerId, 'objective:deleted', { id: obj.id });
  writeAudit({ ownerId, actor: 'owner', action: 'delete', entity: `objective:${obj.id}` });
}

/** When a task is itself cancelled, drop the pristine objective it spawned (its work is
 * abandoned). Left alone if the user organized it into their hierarchy. */
export function dropSourceObjective(taskId: string, ownerId: string): void {
  const obj = sqlite
    .prepare(`SELECT id FROM objectives WHERE source_task_id = ? AND owner_id = ?`)
    .get(taskId, ownerId) as { id: string } | undefined;
  if (!obj || !isPristine(obj.id)) return;
  sqlite.prepare(`DELETE FROM objectives WHERE id = ?`).run(obj.id);
  broadcast(ownerId, 'objective:deleted', { id: obj.id });
  writeAudit({ ownerId, actor: 'owner', action: 'delete', entity: `objective:${obj.id}` });
}

/** Recompute progress for every objective a task is linked to (e.g. after the task is
 * cancelled, so a lingering link's rollup reflects the drop). */
export function recomputeObjectivesForTask(taskId: string): void {
  const objs = sqlite.prepare(`SELECT objective_id FROM objective_tasks WHERE task_id = ? AND linked = 1`).all(taskId) as { objective_id: string }[];
  for (const o of objs) recomputeProgress(o.objective_id);
}

/**
 * First linked objective per task id (M:N — a task can serve several objectives; the
 * task list only needs one, for the star + its click target). Batched to avoid N+1.
 * Ordered by objective id for a stable, deterministic choice.
 */
export function firstObjectiveByTaskIds(taskIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (taskIds.length === 0) return map;
  const rows = sqlite
    .prepare(`SELECT task_id, objective_id FROM objective_tasks WHERE linked = 1 AND task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY objective_id`)
    .all(...taskIds) as { task_id: string; objective_id: string }[];
  for (const r of rows) if (!map.has(r.task_id)) map.set(r.task_id, r.objective_id);
  return map;
}
