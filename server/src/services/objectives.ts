import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';

/**
 * Objectives (Phase N life-planning) — the Goal › Project › Objective tree, built
 * bottom-up: a task-bearing leaf is an "objective", a node whose children are objectives
 * is a "project", and one whose children are projects is a "goal". `level` is derived from
 * a node's HEIGHT (longest path to a leaf descendant), not its depth from the root.
 *
 * Phase W · W8a (Decision 3): extracted VERBATIM from routes/objectives.ts so REST +
 * GraphQL share one owner-scoped implementation — `objectives.test.ts` is the
 * byte-equivalence lock. `writeAudit` + `stampRow` (Phase-L sync versioning) fire INSIDE
 * these functions; SSE `broadcast` stays transport-side (route + resolver each fire it).
 *
 * better-sqlite3 is synchronous; these are plain sync functions.
 */

export interface ObjectiveRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  level: string;
  horizon: string;
  title: string;
  description: string | null;
  target_date: string | null;
  status: string;
  category_id: string | null;
  progress_cache: number | null;
  cadence: string;
  last_advanced_at: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ── Hierarchy leveling (height-from-bottom) ───────────────────────────────────
function heightBelow(id: string): number {
  const row = sqlite
    .prepare(
      `WITH RECURSIVE down(id, depth) AS (
         SELECT id, 0 FROM objectives WHERE id = ?
         UNION ALL
         SELECT o.id, down.depth + 1 FROM objectives o JOIN down ON o.parent_id = down.id
       )
       SELECT MAX(depth) AS d FROM down`,
    )
    .get(id) as { d: number };
  return row.d;
}

function levelFromHeight(h: number): 'goal' | 'project' | 'objective' {
  return h === 0 ? 'objective' : h === 1 ? 'project' : 'goal';
}

/**
 * Link a task to an objective as an addressable, sync-versioned join row (migration
 * 0087). Idempotent: re-linking an existing (possibly tombstoned) row flips it back to
 * `linked = 1` and keeps its surrogate id. Stamps `field_ts`. Returns the link id.
 */
export function linkObjectiveTask(objectiveId: string, taskId: string): string {
  const existing = sqlite
    .prepare(`SELECT id FROM objective_tasks WHERE objective_id = ? AND task_id = ?`)
    .get(objectiveId, taskId) as { id: string | null } | undefined;

  let linkId: string;
  if (existing) {
    linkId = existing.id ?? newId();
    sqlite
      .prepare(`UPDATE objective_tasks SET id = ?, linked = 1 WHERE objective_id = ? AND task_id = ?`)
      .run(linkId, objectiveId, taskId);
  } else {
    linkId = newId();
    sqlite
      .prepare(`INSERT INTO objective_tasks (objective_id, task_id, id, linked) VALUES (?, ?, ?, 1)`)
      .run(objectiveId, taskId, linkId);
  }
  stampRow(sqlite, 'objective_task', linkId, ['linked']);
  return linkId;
}

/**
 * Unlink a task from an objective. Tombstones the join row (`linked = 0`) rather than
 * deleting it, so the unlink round-trips through field-LWW. Stamps `field_ts`. Returns
 * the link id, or null if none existed.
 */
export function unlinkObjectiveTask(objectiveId: string, taskId: string): string | null {
  const existing = sqlite
    .prepare(`SELECT id FROM objective_tasks WHERE objective_id = ? AND task_id = ?`)
    .get(objectiveId, taskId) as { id: string | null } | undefined;
  if (!existing) return null;
  const linkId = existing.id ?? newId();
  sqlite
    .prepare(`UPDATE objective_tasks SET id = ?, linked = 0 WHERE objective_id = ? AND task_id = ?`)
    .run(linkId, objectiveId, taskId);
  stampRow(sqlite, 'objective_task', linkId, ['linked']);
  return linkId;
}

/**
 * Re-stamp `level` for a node AND its ancestors, since a structure change (create /
 * re-parent / delete of a descendant) can change a parent's height and therefore its
 * level. Walks UP the parent chain, guarding against cycles.
 */
export function restampLevels(startId: string | null | undefined): void {
  let cur = startId ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = sqlite.prepare(`SELECT parent_id FROM objectives WHERE id = ?`).get(cur) as
      | { parent_id: string | null }
      | undefined;
    if (!row) break;
    sqlite.prepare(`UPDATE objectives SET level = ? WHERE id = ?`).run(levelFromHeight(heightBelow(cur)), cur);
    cur = row.parent_id;
  }
}

// Would setting obj.parent_id = proposedParent create a cycle? True if proposedParent is a
// descendant of objId (which would cycle back).
function wouldCycle(objId: string, proposedParent: string): boolean {
  if (objId === proposedParent) return true;
  const row = sqlite
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? AS id
         UNION ALL
         SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
       )
       SELECT 1 FROM sub WHERE id = ? LIMIT 1`,
    )
    .get(objId, proposedParent) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * The decorated forest for GET /api/objectives (REST). For each objective computes
 * next_action / effective_target / pace_expected / has_tasks, then nests children under
 * parents. Fetches up-front (no N+1 over rows). Owner-scoped.
 */
export function buildTree(owner: string) {
  const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const objs = sqlite
    .prepare(`SELECT * FROM objectives WHERE owner_id = ? ORDER BY created_at`)
    .all(owner) as ObjectiveRow[];

  if (objs.length === 0) return [];

  const objIds = objs.map((o) => o.id);

  const byId = new Map<string, ObjectiveRow & {
    next_action: null | { id: string; title: string; status: string; scheduled_date: string | null };
    effective_target: string | null;
    pace_expected: number | null;
    has_tasks: boolean;
    children: unknown[];
  }>();

  for (const o of objs) {
    byId.set(o.id, { ...o, next_action: null, effective_target: null, pace_expected: null, has_tasks: false, children: [] });
  }

  // Only ACTIVE links count (migration 0087: unlink tombstones as linked=0, read paths
  // filter linked=1) — so a tombstoned link doesn't keep a node marked task-bearing, which
  // would wrongly block it as a parent. Consistent with the containment guard in updateObjective.
  const withTasks = new Set(
    (sqlite.prepare(`SELECT DISTINCT objective_id FROM objective_tasks WHERE linked = 1`).all() as { objective_id: string }[]).map((r) => r.objective_id),
  );

  for (const id of objIds) {
    const decorated = byId.get(id)!;

    const nextAction = sqlite
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ? AS id
           UNION ALL
           SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
         )
         SELECT t.id, t.title, t.status,
                (SELECT MIN(start_at) FROM time_blocks tb WHERE tb.task_id = t.id AND tb.owner_id = t.owner_id AND DATE(tb.start_at) >= DATE('now')) AS scheduled_date
           FROM objective_tasks ot
           JOIN tasks t ON t.id = ot.task_id
           JOIN sub ON ot.objective_id = sub.id
          WHERE ot.linked = 1 AND t.status NOT IN ('done', 'cancelled', 'deferred')
          ORDER BY t.priority ASC, t.id ASC
          LIMIT 1`,
      )
      .get(id) as { id: string; title: string; status: string; scheduled_date: string | null } | undefined;

    decorated.next_action = nextAction ?? null;
    decorated.has_tasks = withTasks.has(id);

    const effectiveTarget = sqlite
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ? AS id
           UNION ALL
           SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
         )
         SELECT MAX(target_date) AS et
           FROM objectives
           JOIN sub ON objectives.id = sub.id
          WHERE target_date IS NOT NULL`,
      )
      .get(id) as { et: string | null };

    decorated.effective_target = effectiveTarget.et ?? null;

    if (decorated.effective_target) {
      const msCreated = new Date(decorated.created_at.slice(0, 10)).getTime();
      const msTarget = new Date(decorated.effective_target).getTime();
      const msNow = new Date(now).getTime();
      const total = msTarget - msCreated;
      if (total > 0) {
        decorated.pace_expected = Math.max(0, Math.min(1, (msNow - msCreated) / total));
      }
    }
  }

  const roots: unknown[] = [];
  for (const o of byId.values()) {
    if (o.parent_id && byId.has(o.parent_id)) {
      byId.get(o.parent_id)!.children.push(o);
    } else {
      roots.push(o);
    }
  }
  return roots;
}

/**
 * Recompute progress_cache for an objective and all its ancestors (bounded upward walk).
 * Called after task links change or explicitly via recompute.
 */
export function recomputeProgress(objectiveId: string): void {
  const now = new Date().toISOString();

  let currentId: string | null = objectiveId;
  while (currentId) {
    const obj = sqlite
      .prepare(`SELECT id, parent_id FROM objectives WHERE id = ?`)
      .get(currentId) as { id: string; parent_id: string | null } | undefined;
    if (!obj) break;

    const tasks = sqlite
      .prepare(
        `SELECT t.estimated_minutes, t.status
           FROM objective_tasks ot JOIN tasks t ON t.id = ot.task_id
          WHERE ot.objective_id = ? AND ot.linked = 1 AND t.status != 'cancelled'`,
      )
      .all(obj.id) as { estimated_minutes: number | null; status: string }[];

    const children = sqlite
      .prepare(`SELECT progress_cache FROM objectives WHERE parent_id = ?`)
      .all(obj.id) as { progress_cache: number | null }[];

    const allNull = tasks.length === 0 && children.every((c) => c.progress_cache === null);

    let progress: number | null = null;

    if (!allNull) {
      const hasEst = tasks.some((t) => t.estimated_minutes != null && t.estimated_minutes > 0);
      if (hasEst) {
        let done = 0, total = 0;
        for (const t of tasks) {
          const w = t.estimated_minutes ?? 0;
          total += w;
          if (t.status === 'done') done += w;
        }
        for (const c of children) {
          if (c.progress_cache !== null) {
            total += 1;
            done += c.progress_cache;
          }
        }
        progress = total > 0 ? done / total : null;
      } else {
        const doneCount = tasks.filter((t) => t.status === 'done').length;
        const totalTasks = tasks.length + children.filter((c) => c.progress_cache !== null).length;
        const childDone = children.reduce((s, c) => s + (c.progress_cache ?? 0), 0);
        progress = totalTasks > 0 ? (doneCount + childDone) / totalTasks : null;
      }
    }

    sqlite.prepare(`UPDATE objectives SET progress_cache = ?, updated_at = ? WHERE id = ?`).run(progress ?? null, now, obj.id);
    currentId = obj.parent_id;
  }
}

// ── Owner-scoped CRUD (Phase W · W8a) ─────────────────────────────────────────
export interface CreateObjectiveInput {
  title?: string;
  parent_id?: string | null;
  horizon?: string;
  status?: string;
  cadence?: string;
  target_date?: string | null;
  category_id?: string | null;
  priority?: number;
  description?: string | null;
}

/** One of the owner's objectives (raw row), or undefined (not found / not this owner's). */
export function getObjectiveRow(owner: string, id: string): ObjectiveRow | undefined {
  return sqlite.prepare(`SELECT * FROM objectives WHERE id = ? AND owner_id = ?`).get(id, owner) as ObjectiveRow | undefined;
}

/** All of the owner's objectives (flat, created_at order) — GraphQL navigates the tree
 *  via the parent/children field resolvers. */
export function listObjectiveRows(owner: string): ObjectiveRow[] {
  return sqlite.prepare(`SELECT * FROM objectives WHERE owner_id = ? ORDER BY created_at, id`).all(owner) as ObjectiveRow[];
}

/** The owner's objectives whose parent is `parentId` (children of a node). */
export function objectiveChildrenRows(owner: string, parentId: string): ObjectiveRow[] {
  return sqlite.prepare(`SELECT * FROM objectives WHERE owner_id = ? AND parent_id = ? ORDER BY created_at, id`).all(owner, parentId) as ObjectiveRow[];
}

/** The task ids currently linked (linked=1) to an objective, priority-then-id ordered. */
export function objectiveTaskIds(objectiveId: string): string[] {
  return (
    sqlite
      .prepare(
        `SELECT t.id AS id FROM objective_tasks ot JOIN tasks t ON t.id = ot.task_id
          WHERE ot.objective_id = ? AND ot.linked = 1 ORDER BY t.priority ASC, t.id ASC`,
      )
      .all(objectiveId) as { id: string }[]
  ).map((r) => r.id);
}

export type CreateObjectiveResult = { ok: true; row: ObjectiveRow } | { ok: false; error: 'title_required' | 'parent_not_found' };

export function createObjective(owner: string, body: CreateObjectiveInput): CreateObjectiveResult {
  if (!body.title?.trim()) return { ok: false, error: 'title_required' };
  if (body.parent_id) {
    const parent = sqlite.prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`).get(body.parent_id, owner);
    if (!parent) return { ok: false, error: 'parent_not_found' };
  }
  const id = newId();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO objectives
         (id, owner_id, parent_id, title, description, horizon, status, cadence, target_date, category_id, priority, created_at, updated_at, level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, owner, body.parent_id ?? null, body.title.trim(), body.description ?? null,
      body.horizon ?? 'none', body.status ?? 'active', body.cadence ?? 'none',
      body.target_date ?? null, body.category_id ?? null, body.priority ?? 3, now, now,
      'objective', // placeholder — re-stamped from height below
    );
  restampLevels(id);
  stampRow(sqlite, 'objective', id, ['title', 'description', 'parentId', 'horizon', 'status', 'cadence', 'targetDate', 'categoryId', 'priority']);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `objective:${id}` });
  return { ok: true, row: sqlite.prepare(`SELECT * FROM objectives WHERE id = ?`).get(id) as ObjectiveRow };
}

export interface UpdateObjectiveInput extends CreateObjectiveInput {
  completed_at?: string | null;
}
export type UpdateObjectiveResult =
  | { ok: true; row: ObjectiveRow }
  | { ok: false; error: 'not_found' | 'parent_not_found' | 'cycle' | 'parent_has_tasks' };

export function updateObjective(owner: string, id: string, body: UpdateObjectiveInput): UpdateObjectiveResult {
  const existing = getObjectiveRow(owner, id);
  if (!existing) return { ok: false, error: 'not_found' };

  if ('parent_id' in body && body.parent_id != null) {
    const parent = sqlite.prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`).get(body.parent_id, owner);
    if (!parent) return { ok: false, error: 'parent_not_found' };
    if (wouldCycle(id, body.parent_id)) return { ok: false, error: 'cycle' };
    // Containment: a node may not nest under a task-bearing objective.
    const parentHasTasks = sqlite.prepare(`SELECT 1 FROM objective_tasks WHERE objective_id = ? AND linked = 1 LIMIT 1`).get(body.parent_id);
    if (parentHasTasks) return { ok: false, error: 'parent_has_tasks' };
  }

  const oldParentId = existing.parent_id;
  const now = new Date().toISOString();
  const patch = {
    title: body.title ?? existing.title,
    description: 'description' in body ? body.description ?? null : existing.description,
    horizon: body.horizon ?? existing.horizon,
    status: body.status ?? existing.status,
    cadence: body.cadence ?? existing.cadence,
    target_date: 'target_date' in body ? body.target_date ?? null : existing.target_date,
    category_id: 'category_id' in body ? body.category_id ?? null : existing.category_id,
    priority: body.priority ?? existing.priority,
    parent_id: 'parent_id' in body ? body.parent_id ?? null : existing.parent_id,
    completed_at: 'completed_at' in body ? body.completed_at ?? null : existing.completed_at,
  };

  sqlite
    .prepare(
      `UPDATE objectives SET
         title = ?, description = ?, horizon = ?, status = ?, cadence = ?,
         target_date = ?, category_id = ?, priority = ?, parent_id = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
    )
    .run(
      patch.title, patch.description, patch.horizon, patch.status, patch.cadence,
      patch.target_date, patch.category_id, patch.priority, patch.parent_id, patch.completed_at, now, id, owner,
    );

  restampLevels(id);
  if (oldParentId && oldParentId !== patch.parent_id) restampLevels(oldParentId);

  const patchToCamel: Record<string, string> = {
    title: 'title', description: 'description', horizon: 'horizon', status: 'status',
    cadence: 'cadence', target_date: 'targetDate', category_id: 'categoryId',
    priority: 'priority', parent_id: 'parentId', completed_at: 'completedAt',
  };
  const stamped = Object.keys(body).map((k) => patchToCamel[k]).filter(Boolean);
  if (stamped.length > 0) stampRow(sqlite, 'objective', id, stamped);

  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `objective:${id}` });
  return { ok: true, row: sqlite.prepare(`SELECT * FROM objectives WHERE id = ?`).get(id) as ObjectiveRow };
}

export type DeleteObjectiveResult = { ok: true; parentId: string | null } | { ok: false; error: 'not_found' };

export function deleteObjective(owner: string, id: string): DeleteObjectiveResult {
  const existing = sqlite.prepare(`SELECT id, parent_id FROM objectives WHERE id = ? AND owner_id = ?`).get(id, owner) as
    | { id: string; parent_id: string | null }
    | undefined;
  if (!existing) return { ok: false, error: 'not_found' };
  sqlite.prepare(`DELETE FROM objectives WHERE id = ? AND owner_id = ?`).run(id, owner);
  restampLevels(existing.parent_id);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `objective:${id}` });
  return { ok: true, parentId: existing.parent_id };
}

export type LinkTaskResult =
  | { ok: true; linkId: string }
  | { ok: false; error: 'objective_not_found' | 'task_id_required' | 'non_leaf' | 'task_not_found' };

/** Link a task to a (leaf) objective. Preserves the route's validation order + messages. */
export function linkTaskToObjective(owner: string, objId: string, taskId: string | undefined): LinkTaskResult {
  const obj = sqlite.prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`).get(objId, owner);
  if (!obj) return { ok: false, error: 'objective_not_found' };
  if (!taskId) return { ok: false, error: 'task_id_required' };
  // Containment: tasks live only at the leaf (objective) level.
  if (heightBelow(objId) > 0) return { ok: false, error: 'non_leaf' };
  const task = sqlite.prepare(`SELECT id FROM tasks WHERE id = ? AND owner_id = ?`).get(taskId, owner);
  if (!task) return { ok: false, error: 'task_not_found' };
  const linkId = linkObjectiveTask(objId, taskId);
  recomputeProgress(objId);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'link', entity: `objective:${objId}:task:${taskId}` });
  return { ok: true, linkId };
}

/**
 * Unlink a task from an objective. Owner-scoped (the REST route was NOT — a latent
 * cross-owner tombstone; this hardens it without changing same-owner behavior): a foreign
 * objId is a no-op returning null. Idempotent otherwise.
 */
export function unlinkTaskFromObjective(owner: string, objId: string, taskId: string): { linkId: string | null } {
  const obj = sqlite.prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`).get(objId, owner);
  if (!obj) return { linkId: null };
  const linkId = unlinkObjectiveTask(objId, taskId);
  recomputeProgress(objId);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'unlink', entity: `objective:${objId}:task:${taskId}` });
  return { linkId };
}

export type RecomputeResult = { ok: true } | { ok: false; error: 'not_found' };

export function recomputeObjective(owner: string, id: string): RecomputeResult {
  const obj = sqlite.prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`).get(id, owner);
  if (!obj) return { ok: false, error: 'not_found' };
  recomputeProgress(id);
  return { ok: true };
}
