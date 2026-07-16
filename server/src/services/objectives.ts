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
  /** 0129 — non-null ⇒ archived: kept indefinitely, absent from the live tree. */
  archived_at: string | null;
  /** 0129 — the objective whose archiving cascaded to this row; NULL on the root. */
  archive_root_id: string | null;
  /** 0129 — non-null ⇒ permanent deletion requested; the hourly purge_objectives job
   *  reaps it past this absolute deadline. Restorable until then. */
  purge_after: string | null;
}

// ── Hierarchy leveling (height-from-bottom) ───────────────────────────────────
function heightBelow(id: string): number {
  const row = sqlite
    .prepare(
      // Level is a function of the LIVE tree, so archived descendants stop propping
      // their ancestors up. Consequence: archiving the last child of a project
      // demotes it project → objective (owner-accepted, 2026-07-15).
      `WITH RECURSIVE down(id, depth) AS (
         SELECT id, 0 FROM objectives WHERE id = ?
         UNION ALL
         SELECT o.id, down.depth + 1 FROM objectives o JOIN down ON o.parent_id = down.id
          WHERE o.archived_at IS NULL
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

/** Minimal task row attached to leaf objectives in the GET /api/objectives tree (AF-2). */
export interface ObjectiveTaskSummary {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  due_at: string | null;
  scheduled_for: string | null;
  parent_id: string | null;
  completed_at: string | null;
}

/**
 * The decorated forest for GET /api/objectives (REST). For each objective computes
 * next_action / effective_target / pace_expected / has_tasks, then nests children under
 * parents. Fetches up-front (no N+1 over rows). Owner-scoped.
 *
 * AF-2: every node also carries `tasks: ObjectiveTaskSummary[]` — ALWAYS present, so the
 * client never branches on shape. Only LEAF nodes (no children in the owner's forest) are
 * populated; non-leaves are always `[]` (leaf-only linking is enforced on writes, so this
 * loses nothing). Active links only (linked=1), cancelled tasks excluded. Fetched in ONE
 * batched query for the whole forest, ordered priority ASC → due_at ASC (NULLs last) → id.
 * next_action / has_tasks are unchanged (the client depends on them until Wave 2).
 */
export function buildTree(owner: string) {
  const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const objs = sqlite
    .prepare(`SELECT * FROM objectives WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at`)
    .all(owner) as ObjectiveRow[];

  if (objs.length === 0) return [];

  const objIds = objs.map((o) => o.id);

  const byId = new Map<string, ObjectiveRow & {
    next_action: null | { id: string; title: string; status: string; scheduled_date: string | null };
    effective_target: string | null;
    pace_expected: number | null;
    has_tasks: boolean;
    tasks: ObjectiveTaskSummary[];
    children: unknown[];
  }>();

  for (const o of objs) {
    byId.set(o.id, { ...o, next_action: null, effective_target: null, pace_expected: null, has_tasks: false, tasks: [], children: [] });
  }

  // AF-2: linked tasks for LEAF nodes, one batched query for the whole forest (no per-node
  // loop). Owner-scoped on BOTH sides (objective + task) like objectiveForTask, so a
  // stray/dangling objective_tasks row can't leak another owner's task. Active links only
  // (linked=1 — tombstones excluded), cancelled tasks excluded.
  const isParent = new Set(objs.map((o) => o.parent_id).filter((p): p is string => p != null));
  const linkedTasks = sqlite
    .prepare(
      `SELECT ot.objective_id AS objective_id,
              t.id, t.title, t.status, t.priority, t.due_at, t.scheduled_for, t.parent_id, t.completed_at
         FROM objective_tasks ot
         JOIN tasks t ON t.id = ot.task_id
         JOIN objectives o ON o.id = ot.objective_id
        WHERE o.owner_id = ? AND t.owner_id = ? AND ot.linked = 1 AND t.status != 'cancelled'
        ORDER BY t.priority ASC, (t.due_at IS NULL) ASC, t.due_at ASC, t.id ASC`,
    )
    .all(owner, owner) as (ObjectiveTaskSummary & { objective_id: string })[];
  for (const { objective_id, ...task } of linkedTasks) {
    const node = byId.get(objective_id);
    if (!node || isParent.has(objective_id)) continue; // leaf-only (write-enforced; belt-and-braces)
    node.tasks.push(task);
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

    // An archived child must not keep dragging its parent's completion.
    const children = sqlite
      .prepare(`SELECT progress_cache FROM objectives WHERE parent_id = ? AND archived_at IS NULL`)
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
  return sqlite
    .prepare(`SELECT * FROM objectives WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at, id`)
    .all(owner) as ObjectiveRow[];
}

/** The owner's ARCHIVED objectives — a flat list (an archived subtree is not a tree
 *  the panel can render). Newest first: the archive reads as a history. */
export function listArchivedObjectiveRows(owner: string): ObjectiveRow[] {
  return sqlite
    .prepare(`SELECT * FROM objectives WHERE owner_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC, id`)
    .all(owner) as ObjectiveRow[];
}

/** The owner's objectives whose parent is `parentId` (children of a node). */
export function objectiveChildrenRows(owner: string, parentId: string): ObjectiveRow[] {
  return sqlite
    .prepare(`SELECT * FROM objectives WHERE owner_id = ? AND parent_id = ? AND archived_at IS NULL ORDER BY created_at, id`)
    .all(owner, parentId) as ObjectiveRow[];
}

/**
 * The FIRST objective a task is linked to (over objective_tasks, linked=1), owner-scoped —
 * backs GraphQL `TaskType.objective`. Deterministic pick: earliest-created, then id (a task
 * may be linked to several objectives). Undefined when none / the task isn't the owner's.
 * Owner-scoped via the objectives.owner_id join, so a cross-owner link can't leak.
 */
export function objectiveForTask(owner: string, taskId: string): ObjectiveRow | undefined {
  return sqlite
    .prepare(
      // Scope BOTH sides by owner (objective + task): the join to `tasks` makes this
      // self-sufficiently owner-safe — a stray/dangling objective_tasks row (sync/import)
      // pointing at another owner's task can't surface an objective here.
      `SELECT o.* FROM objectives o
         JOIN objective_tasks ot ON ot.objective_id = o.id
         JOIN tasks t ON t.id = ot.task_id
        WHERE ot.task_id = ? AND ot.linked = 1 AND o.owner_id = ? AND t.owner_id = ?
        ORDER BY o.created_at, o.id LIMIT 1`,
    )
    .get(taskId, owner, owner) as ObjectiveRow | undefined;
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

/** How long a "delete permanently" stays reversible. One constant — deliberately not
 *  configurable (mirrors the hardcoded 30-day sync_events retention). */
export const PURGE_WINDOW_HOURS = 48;

/** The live (non-archived) descendants of `id`, deepest-last. Used to cascade an
 *  archive over a subtree: already-archived nodes are skipped so restoring the root
 *  never resurrects something archived independently earlier. */
function liveDescendantIds(id: string): string[] {
  return (sqlite
    .prepare(
      `WITH RECURSIVE down(id) AS (
         SELECT id FROM objectives WHERE id = ?
         UNION ALL
         SELECT o.id FROM objectives o JOIN down ON o.parent_id = down.id
          WHERE o.archived_at IS NULL
       )
       SELECT id FROM down WHERE id != ?`,
    )
    .all(id, id) as { id: string }[]).map((r) => r.id);
}

/**
 * Archive an objective and its live subtree. Replaces the old hard delete.
 *
 * The row is kept indefinitely — only an explicit purge request (requestPurge) starts
 * the 48h reversal clock. Descendants are stamped with `archive_root_id` so the
 * subtree restores as a unit; without the cascade, `parent_id`'s ON DELETE SET NULL
 * would silently re-root the children at purge time.
 */
export function archiveObjective(owner: string, id: string): DeleteObjectiveResult {
  const existing = sqlite
    .prepare(`SELECT id, parent_id, archived_at FROM objectives WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as { id: string; parent_id: string | null; archived_at: string | null } | undefined;
  if (!existing) return { ok: false, error: 'not_found' };
  if (existing.archived_at) return { ok: true, parentId: existing.parent_id }; // idempotent

  const now = new Date().toISOString(); // NEVER CURRENT_TIMESTAMP — format must string-compare
  const descendants = liveDescendantIds(id);

  sqlite.prepare(`UPDATE objectives SET archived_at = ? WHERE id = ? AND owner_id = ?`).run(now, id, owner);
  stampRow(sqlite, 'objective', id, ['archivedAt']);
  for (const child of descendants) {
    sqlite
      .prepare(`UPDATE objectives SET archived_at = ?, archive_root_id = ? WHERE id = ? AND owner_id = ?`)
      .run(now, id, child, owner);
    stampRow(sqlite, 'objective', child, ['archivedAt', 'archiveRootId']);
  }

  // The parent just lost a live child: its height (and so its level) may drop, and its
  // rollup must stop counting the archived branch. recomputeProgress is new here — the
  // old deleteObjective omitted it, leaving a stale progress_cache behind.
  restampLevels(existing.parent_id);
  if (existing.parent_id) recomputeProgress(existing.parent_id);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'archive', entity: `objective:${id}` });
  return { ok: true, parentId: existing.parent_id };
}

/**
 * Restore an archived objective and everything archived alongside it, clearing any
 * pending purge. THIS is the reversal: the row never left the table, so it is one
 * UPDATE — no id is re-minted and no FK or link tombstone was ever destroyed.
 */
export function restoreObjective(owner: string, id: string): DeleteObjectiveResult {
  const existing = sqlite
    .prepare(`SELECT id, parent_id, archived_at FROM objectives WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as { id: string; parent_id: string | null; archived_at: string | null } | undefined;
  if (!existing) return { ok: false, error: 'not_found' };

  const subtree = (sqlite
    .prepare(`SELECT id FROM objectives WHERE owner_id = ? AND archive_root_id = ?`)
    .all(owner, id) as { id: string }[]).map((r) => r.id);

  for (const rowId of [id, ...subtree]) {
    sqlite
      .prepare(`UPDATE objectives SET archived_at = NULL, archive_root_id = NULL, purge_after = NULL WHERE id = ? AND owner_id = ?`)
      .run(rowId, owner);
    stampRow(sqlite, 'objective', rowId, ['archivedAt', 'archiveRootId']);
  }

  restampLevels(existing.parent_id);
  restampLevels(id);
  if (existing.parent_id) recomputeProgress(existing.parent_id);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'restore', entity: `objective:${id}` });
  return { ok: true, parentId: existing.parent_id };
}

export type PurgeResult =
  | { ok: true; purgeAfter: string | null }
  | { ok: false; error: 'not_found' | 'not_archived' | 'live_children' };

/**
 * Request permanent deletion: stamp an absolute deadline across the archived subtree
 * so it purges atomically. Storing the ABSOLUTE deadline (rather than a requested_at
 * the job adds 48h to) means changing PURGE_WINDOW_HOURS later cannot retroactively
 * vaporize rows already in the window.
 *
 * `purge_after` is intentionally NOT stamped for sync — it is a server-owned deadline
 * (like level/progress_cache), so a client cannot author it.
 */
export function requestPurge(owner: string, id: string): PurgeResult {
  const row = sqlite
    .prepare(`SELECT id, archived_at FROM objectives WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as { id: string; archived_at: string | null } | undefined;
  if (!row) return { ok: false, error: 'not_found' };
  if (!row.archived_at) return { ok: false, error: 'not_archived' };
  // A live child would be silently re-rooted by ON DELETE SET NULL when the job fires.
  // The cascade means this should be unreachable; it is a guard, not a workflow.
  const live = sqlite
    .prepare(`SELECT 1 FROM objectives WHERE parent_id = ? AND archived_at IS NULL LIMIT 1`)
    .get(id);
  if (live) return { ok: false, error: 'live_children' };

  const deadline = new Date(Date.now() + PURGE_WINDOW_HOURS * 3600_000).toISOString();
  sqlite
    .prepare(`UPDATE objectives SET purge_after = ? WHERE owner_id = ? AND (id = ? OR archive_root_id = ?)`)
    .run(deadline, owner, id, id);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'purge:request', entity: `objective:${id}` });
  return { ok: true, purgeAfter: deadline };
}

/** Cancel a pending permanent deletion — the reversal itself. */
export function cancelPurge(owner: string, id: string): PurgeResult {
  const row = sqlite.prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`).get(id, owner);
  if (!row) return { ok: false, error: 'not_found' };
  sqlite
    .prepare(`UPDATE objectives SET purge_after = NULL WHERE owner_id = ? AND (id = ? OR archive_root_id = ?)`)
    .run(owner, id, id);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'purge:cancel', entity: `objective:${id}` });
  return { ok: true, purgeAfter: null };
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
