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
 * Reads/writes go through the store facade; the raw `sqlite` handle survives only as
 * the argument to `stampRow` (dies when sync/apply.ts ports).
 */
import { sqlite } from '../db/index.js';
import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { broadcast } from '../routes/sse.js';
import { recomputeProgress, linkObjectiveTask } from './objectives.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';

/** Active (non-ephemeral, non-cancelled) subtasks of a parent — the objective's work.
 * Excludes `quick` ritual-local tasks and materialized recurrence instances, which
 * shouldn't pollute the strategic layer or its progress rollups. */
async function linkableSubtaskIds(parentTaskId: string, ownerId: string): Promise<string[]> {
  return (await store()
    .prepare(
      `SELECT id FROM tasks
        WHERE parent_id = ? AND owner_id = ? AND status != 'cancelled'
          AND subtype != 'quick' AND recurrence_parent_id IS NULL`,
    )
    .all<{ id: string }>(parentTaskId, ownerId)).map((r) => r.id);
}

/**
 * Ensure the parent task (which just gained a subtask) is promoted to its own leaf
 * objective, and that the parent + its current linkable subtasks are linked to it.
 * Returns the objective id, or null if the parent doesn't exist / isn't linkable.
 */
export async function ensureTaskPromoted(parentTaskId: string, ownerId: string): Promise<string | null> {
  const parent = await store()
    .prepare(`SELECT id, title, subtype, recurrence_parent_id FROM tasks WHERE id = ? AND owner_id = ?`)
    .get<{ id: string; title: string; subtype: string | null; recurrence_parent_id: string | null }>(parentTaskId, ownerId);
  // Don't promote ephemeral parents (a quick task or a recurrence instance shouldn't
  // spawn a strategic objective).
  if (!parent || parent.subtype === 'quick' || parent.recurrence_parent_id) return null;

  // Find-or-create THIS task's objective (keyed on source_task_id, not "any link").
  const existing = await store()
    .prepare(`SELECT id FROM objectives WHERE source_task_id = ? AND owner_id = ?`)
    .get<{ id: string }>(parentTaskId, ownerId);

  let objId: string;
  let created = false;
  if (existing) {
    objId = existing.id;
  } else {
    objId = newId();
    const now = new Date().toISOString();
    await store()
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
  const linkedTaskIds = [parentTaskId, ...(await linkableSubtaskIds(parentTaskId, ownerId))];
  // An explicit loop, not `.map`: linkObjectiveTask is async now, so `.map` would collect
  // PROMISES and the broadcast below would publish `[object Promise]` as the link id —
  // typecheck-clean, because the broadcast payload is unknown. Sequential also keeps each
  // link's probe-then-write off the next one's.
  const linkIds: string[] = [];
  for (const tid of linkedTaskIds) linkIds.push(await linkObjectiveTask(objId, tid));

  await recomputeProgress(objId);
  broadcast(ownerId, created ? 'objective:created' : 'objective:updated', { id: objId });
  for (const linkId of linkIds) broadcast(ownerId, 'objective_task:updated', { id: linkId });
  for (const tid of linkedTaskIds) broadcast(ownerId, 'task:updated', { id: tid });
  writeAudit({ ownerId, actor: 'owner', action: created ? 'create' : 'link', entity: `objective:${objId}` });
  return objId;
}

/** A promoted objective is "pristine" (safe to auto-GC) only while it's still a
 * top-level leaf the user hasn't organized into their hierarchy. */
async function isPristine(objId: string): Promise<boolean> {
  const row = await store().prepare(`SELECT parent_id FROM objectives WHERE id = ?`).get<{ parent_id: string | null }>(objId);
  if (!row || row.parent_id != null) return false;
  const child = await store().prepare(`SELECT 1 FROM objectives WHERE parent_id = ? LIMIT 1`).get(objId);
  return !child;
}

/**
 * Un-promote: when a parent task has no active subtasks left, delete its pristine
 * auto-created objective so childless single-task objectives don't accumulate. No-op
 * if the objective was organized under a project/goal (then it's the user's to keep).
 */
export async function unpromoteIfEmpty(parentTaskId: string, ownerId: string): Promise<void> {
  const obj = await store()
    .prepare(`SELECT id FROM objectives WHERE source_task_id = ? AND owner_id = ?`)
    .get<{ id: string }>(parentTaskId, ownerId);
  if (!obj) return;
  const activeSubs = (await store()
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND owner_id = ? AND status != 'cancelled' AND subtype != 'quick' AND recurrence_parent_id IS NULL`)
    .get<{ n: number }>(parentTaskId, ownerId))!.n;
  if (activeSubs > 0 || !(await isPristine(obj.id))) return;
  // Deliberately a HARD delete, not the archive (0129): isPristine guarantees this is
  // auto-generated scaffolding the user never organized, so archiving it would fill
  // their archive with rows they never chose to delete. This is only safe WHILE
  // isPristine holds — relaxing it breaks owner-scoping (no owner_id below), leveling
  // (no restampLevels) and rollups (no recomputeProgress) all at once.
  await store().prepare(`DELETE FROM objectives WHERE id = ?`).run(obj.id); // cascades objective_tasks
  broadcast(ownerId, 'objective:deleted', { id: obj.id });
  writeAudit({ ownerId, actor: 'owner', action: 'delete', entity: `objective:${obj.id}` });
}

/** When a task is itself cancelled, drop the pristine objective it spawned (its work is
 * abandoned). Left alone if the user organized it into their hierarchy. */
export async function dropSourceObjective(taskId: string, ownerId: string): Promise<void> {
  const obj = await store()
    .prepare(`SELECT id FROM objectives WHERE source_task_id = ? AND owner_id = ?`)
    .get<{ id: string }>(taskId, ownerId);
  if (!obj || !(await isPristine(obj.id))) return;
  // Hard delete, not the archive (0129) — same isPristine rationale as unpromoteIfEmpty.
  await store().prepare(`DELETE FROM objectives WHERE id = ?`).run(obj.id);
  broadcast(ownerId, 'objective:deleted', { id: obj.id });
  writeAudit({ ownerId, actor: 'owner', action: 'delete', entity: `objective:${obj.id}` });
}

/** Recompute progress for every objective a task is linked to (e.g. after the task is
 * cancelled, so a lingering link's rollup reflects the drop).
 *
 * Deliberately NOT filtered by `archived_at` (0129), unlike the read paths below. This
 * writes `progress_cache` rather than showing it, and archiving must be losslessly
 * reversible: skipping archived objectives would freeze their rollup at archive-time, so
 * a restore months later would surface a number that silently ignores everything the
 * owner did to its tasks in between. The upward walk stays correct either way —
 * recomputeProgress's child rollup already excludes archived children, so a live ancestor
 * never counts this branch. Cost is a rollup nobody is currently looking at; the archive
 * list does render progress_cache, so it isn't even wasted. */
export async function recomputeObjectivesForTask(taskId: string): Promise<void> {
  const objs = await store().prepare(`SELECT objective_id FROM objective_tasks WHERE task_id = ? AND linked = 1`).all<{ objective_id: string }>(taskId);
  for (const o of objs) await recomputeProgress(o.objective_id);
}

/**
 * ALL LIVE linked objective ids per task id (M:N over objective_tasks, linked=1 only —
 * tombstoned links excluded). Batched to avoid N+1. AF-10: backs the task payload's
 * `objective_ids`; its first element backs the legacy `objective_id` decoration.
 *
 * `objective_ids` means LIVE links only — archived objectives are excluded (0129). The
 * join row alone cannot answer "is this link live?": archiveObjective is a SOFT delete
 * that deliberately leaves `linked = 1` so a restore is lossless, so every reader must
 * check `o.archived_at` too. Reporting archived links here would make the task card's
 * star mean "in an objective, or maybe in one you deleted", and the card's picker offers
 * unlink only from a CHECKED row — a link matching no live row is one the owner cannot
 * remove at all. Same rule the `objective` query resolver states from the other side:
 * the graph is the LIVE graph.
 *
 * Ordering + scoping deliberately mirror services/objectives.ts objectiveForTask
 * (which backs GraphQL TaskType.objective): ORDER BY o.created_at, o.id, BOTH sides
 * owner-scoped (objective + task) so a stray/dangling objective_tasks row pointing at
 * another owner's row can never surface here, and the SAME archived_at filter. That
 * keeps REST's objective_id and GraphQL's objective agreeing on the same first
 * objective. Change one, change the other.
 */
export async function objectiveIdsByTaskIds(ownerId: string, taskIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  const rows = await store()
    .prepare(
      `SELECT ot.task_id, ot.objective_id FROM objective_tasks ot
         JOIN objectives o ON o.id = ot.objective_id
         JOIN tasks t ON t.id = ot.task_id
        WHERE ot.linked = 1 AND o.owner_id = ? AND t.owner_id = ?
          AND o.archived_at IS NULL
          AND ot.task_id IN (${taskIds.map(() => '?').join(',')})
        ORDER BY o.created_at, o.id`,
    )
    .all<{ task_id: string; objective_id: string }>(ownerId, ownerId, ...taskIds);
  for (const r of rows) {
    const list = map.get(r.task_id);
    if (list) list.push(r.objective_id);
    else map.set(r.task_id, [r.objective_id]);
  }
  return map;
}
