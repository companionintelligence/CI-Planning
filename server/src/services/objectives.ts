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

    // Two rules on this walk, both matching the linkedTasks query above:
    //
    // 1. LIVE tree only (`archived_at IS NULL`) — the rule recomputeProgress's child
    //    rollup and heightBelow already follow: an archived branch must not keep feeding
    //    its live ancestor. Without it, archiving a sub-project leaves its tasks surfacing
    //    as the parent's next action — work the owner just filed away. (The root `id` is a
    //    live node by construction; only descendants need filtering.)
    // 2. The OWNER's subtree only. `parent_id` is validated owner-side on write, but
    //    sync/apply.ts and backup import write objectives rows directly, so a cross-owner
    //    edge is the same "stray/dangling row" case linkedTasks defends against — and an
    //    unconstrained descent would walk straight into another owner's branch. Scoped in
    //    the recursive step AND on `t.owner_id`, so it is self-sufficiently owner-safe
    //    whichever half is corrupt (a bad parent_id or a bad objective_tasks row).
    const nextAction = sqlite
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ? AS id
           UNION ALL
           SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
            WHERE o.archived_at IS NULL AND o.owner_id = ?
         )
         SELECT t.id, t.title, t.status,
                (SELECT MIN(start_at) FROM time_blocks tb WHERE tb.task_id = t.id AND tb.owner_id = t.owner_id AND DATE(tb.start_at) >= DATE('now')) AS scheduled_date
           FROM objective_tasks ot
           JOIN tasks t ON t.id = ot.task_id
           JOIN sub ON ot.objective_id = sub.id
          WHERE ot.linked = 1 AND t.owner_id = ? AND t.status NOT IN ('done', 'cancelled', 'deferred')
          ORDER BY t.priority ASC, t.id ASC
          LIMIT 1`,
      )
      .get(id, owner, owner) as { id: string; title: string; status: string; scheduled_date: string | null } | undefined;

    decorated.next_action = nextAction ?? null;
    decorated.has_tasks = withTasks.has(id);

    // Live subtree, owner's subtree — same two reasons as next_action above. An archived
    // branch's target_date must not keep setting its live ancestor's effective target, and
    // a cross-owner branch must not set it at all (MAX() would happily take a stranger's
    // date). Scoped in the recursive step and again in the final select.
    const effectiveTarget = sqlite
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ? AS id
           UNION ALL
           SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
            WHERE o.archived_at IS NULL AND o.owner_id = ?
         )
         SELECT MAX(target_date) AS et
           FROM objectives
           JOIN sub ON objectives.id = sub.id
          WHERE target_date IS NOT NULL AND objectives.owner_id = ?`,
      )
      .get(id, owner, owner) as { et: string | null };

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

// ── The rollup's task-status vocabulary ───────────────────────────────────────
//
// recomputeProgress reads a linked task's `status` in exactly TWO ways, and nothing
// else about it matters to a rollup. Both live here, next to the query that uses them,
// so a caller deciding "should I recompute?" can ask THIS module instead of re-deriving
// the rule. updateTask once hardcoded its own answer ("was it done?") and silently
// missed the cancelled boundary, freezing an objective at its cancel-time percentage
// when the task was restored — see [[rollupStatusFacet]].

/**
 * Task statuses the rollup EXCLUDES outright: cancelled work is abandoned, so it leaves
 * the denominator rather than counting as incomplete forever. Add a status here and both
 * the query below AND every recompute trigger widen together — that is the point.
 */
export const ROLLUP_EXCLUDED_TASK_STATUSES = ['cancelled'] as const;
/** SQL list literal for `t.status NOT IN (${ROLLUP_EXCLUDED_TASK_STATUS_SQL})`. */
export const ROLLUP_EXCLUDED_TASK_STATUS_SQL = ROLLUP_EXCLUDED_TASK_STATUSES.map((s) => `'${s}'`).join(',');
/** The one status the rollup counts as complete (the numerator). */
export const ROLLUP_DONE_TASK_STATUS = 'done';

/** What a rollup sees when it looks at one task's status. Anything not listed is just
 *  "outstanding work" — the rollup cannot tell 'open' from 'scheduled'. */
export type RollupStatusFacet = 'done' | 'counted' | 'excluded' | 'absent';

/**
 * Project a task status onto everything the rollup can perceive about it. Two statuses
 * with the same facet are interchangeable to `progress_cache`; two with different facets
 * mean the rollup is now stale.
 *
 * This is the trigger predicate for callers that mutate `tasks.status`: recompute iff the
 * facet changed. Derived from the constants above rather than a second hardcoded list, so
 * a new excluded status can't leave a mutator behind (which is exactly how the
 * cancelled→open restore path came to be missed).
 */
export function rollupStatusFacet(status: string | null | undefined): RollupStatusFacet {
  if (status == null) return 'absent';
  if ((ROLLUP_EXCLUDED_TASK_STATUSES as readonly string[]).includes(status)) return 'excluded';
  return status === ROLLUP_DONE_TASK_STATUS ? 'done' : 'counted';
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
          WHERE ot.objective_id = ? AND ot.linked = 1
            AND t.status NOT IN (${ROLLUP_EXCLUDED_TASK_STATUS_SQL})`,
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
          if (t.status === ROLLUP_DONE_TASK_STATUS) done += w;
        }
        for (const c of children) {
          if (c.progress_cache !== null) {
            total += 1;
            done += c.progress_cache;
          }
        }
        progress = total > 0 ? done / total : null;
      } else {
        const doneCount = tasks.filter((t) => t.status === ROLLUP_DONE_TASK_STATUS).length;
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

/**
 * The owner's ARCHIVED objectives — a FLAT list (an archived subtree is not a tree the
 * panel can render). Newest first: the archive reads as a history.
 *
 * Decorated with the same server-computed keys buildTree adds, at their empty defaults,
 * so `GET /api/objectives` returns ONE shape whichever branch answers — the client's
 * `Objective` type says these keys always exist, and a caller shouldn't have to know
 * which query produced the row. The values are genuinely empty rather than computed:
 * next_action/progress are about live work, and an archived node has none.
 */
export function listArchivedObjectiveRows(owner: string): ObjectiveRow[] {
  const rows = sqlite
    .prepare(`SELECT * FROM objectives WHERE owner_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC, id`)
    .all(owner) as ObjectiveRow[];
  return rows.map((o) => ({
    ...o,
    next_action: null,
    effective_target: null,
    pace_expected: null,
    has_tasks: false,
    tasks: [],
    children: [], // flat by construction — the subtree is conveyed by archive_root_id
  })) as ObjectiveRow[];
}

/** The owner's objectives whose parent is `parentId` (children of a node). */
export function objectiveChildrenRows(owner: string, parentId: string): ObjectiveRow[] {
  return sqlite
    .prepare(`SELECT * FROM objectives WHERE owner_id = ? AND parent_id = ? AND archived_at IS NULL ORDER BY created_at, id`)
    .all(owner, parentId) as ObjectiveRow[];
}

/**
 * The FIRST LIVE objective a task is linked to (over objective_tasks, linked=1),
 * owner-scoped — backs GraphQL `TaskType.objective`. Deterministic pick: earliest-created,
 * then id (a task may be linked to several objectives). Undefined when none / the task
 * isn't the owner's. Owner-scoped via the objectives.owner_id join, so a cross-owner link
 * can't leak.
 *
 * Archived objectives are excluded (0129), which is what keeps the graph self-consistent:
 * `task.objective` and `objective(id:)` reach the same node by two paths, so an archived
 * objective reachable through this one would resolve to an object here and null there.
 * Mirrors task-promotion.ts objectiveIdsByTaskIds (REST `objective_ids`) exactly — same
 * filter, same order. Change one, change the other.
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
          AND o.archived_at IS NULL
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

/**
 * Can `parentId` be used as a parent by `owner`? It must exist, be theirs, and be LIVE.
 *
 * An archived objective is not a parent: it is absent from the tree every read path builds,
 * so `parent_not_found` is the honest answer — the same one a made-up id gets. Accepting it
 * would not nest anything, it would CORRUPT the tree: buildTree filters archived rows out of
 * `objs` and then roots any node whose parent isn't in the map, so the child silently
 * resurfaces as a top-level goal — a 200 doing the opposite of what was asked. That is the
 * same hazard [[archiveObjective]] cites when explaining why its cascade must be atomic.
 *
 * The rule lifts on restore, because it is about the live tree rather than the row.
 *
 * Shared by create + update so the two can't drift — they were byte-identical, and both
 * missed `archived_at` when 0129 landed.
 */
function liveParentExists(owner: string, parentId: string): boolean {
  return sqlite
    .prepare(`SELECT 1 FROM objectives WHERE id = ? AND owner_id = ? AND archived_at IS NULL LIMIT 1`)
    .get(parentId, owner) !== undefined;
}

export function createObjective(owner: string, body: CreateObjectiveInput): CreateObjectiveResult {
  if (!body.title?.trim()) return { ok: false, error: 'title_required' };
  // `!= null`, not truthiness: '' is a PROVIDED parent that no objective can satisfy, so it
  // must be refused like any other unknown id. Under a truthy check it skipped validation
  // and reached the INSERT, where `parent_id REFERENCES objectives(id)` rejected it — a 500
  // leaking "FOREIGN KEY constraint failed" where a 422 belongs. (No row was ever written:
  // the FK is what caught it, so this was a wrong-answer bug, not silent corruption.)
  // updateObjective already guards with `!= null`; this makes the two agree.
  if (body.parent_id != null) {
    if (!liveParentExists(owner, body.parent_id)) return { ok: false, error: 'parent_not_found' };
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
    if (!liveParentExists(owner, body.parent_id)) return { ok: false, error: 'parent_not_found' };
    if (wouldCycle(id, body.parent_id)) return { ok: false, error: 'cycle' };
    // Containment: a node may not nest under a task-bearing objective. No archived_at
    // check needed here — liveParentExists above has already refused an archived parent,
    // so by this line the parent is live and this asks only about its tasks.
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
 * Archive `id`'s live descendants, stamping each with `archive_root_id` so the subtree
 * restores as a unit. Assumes the ROOT's own `archived_at` is already written; this is
 * only the fan-out.
 *
 * THE INVARIANT IT KEEPS: no live objective may have an archived parent. buildTree filters
 * archived rows out and roots any node whose parent is missing from the map, so a live
 * child left under an archived parent doesn't nest — it silently resurfaces as a top-level
 * goal.
 *
 * Shared with the sync path (routes/sync.ts → applySyncedObjectiveUpkeep): applyOp writes
 * `archived_at` raw and never calls archiveObjective, so without this a synced archive
 * would leave its whole live subtree orphaned. Call it inside a transaction.
 */
export function cascadeArchiveToDescendants(owner: string, id: string, archivedAt: string): string[] {
  const descendants = liveDescendantIds(id);
  for (const child of descendants) {
    sqlite
      .prepare(`UPDATE objectives SET archived_at = ?, archive_root_id = ? WHERE id = ? AND owner_id = ?`)
      .run(archivedAt, id, child, owner);
    stampRow(sqlite, 'objective', child, ['archivedAt', 'archiveRootId']);
  }
  return descendants;
}

/**
 * Objective upkeep after a RAW sync write. applyOp writes columns directly and never goes
 * through these services, so the invariants they maintain have to be re-established here —
 * the same reason routes/sync.ts already re-runs the task→block done-state mirror by hand.
 *
 * Two things sync can break that the API cannot (as of #371):
 *  - `archived_at` set ⇒ the live subtree must follow, exactly as archiveObjective does.
 *    Without it, archiving offline orphans every child. This is the LIKELIER corruption
 *    path — it needs no parent_id op at all.
 *  - `parent_id` moved ⇒ `level` is height-derived, so both the old and new ancestor chains
 *    can change. (An un-archive is deliberately NOT cascaded: restoreObjective is root-only
 *    by design, and a member archived independently earlier must stay archived.)
 *
 * Idempotent and safe to call for any applied field set; a no-op unless one of those two
 * fields actually landed.
 */
export function applySyncedObjectiveUpkeep(owner: string, id: string, applied: Record<string, unknown>): void {
  const touchedParent = 'parent_id' in applied;
  const touchedArchive = 'archived_at' in applied;
  if (!touchedParent && !touchedArchive) return;

  const row = getObjectiveRow(owner, id);
  if (!row) return;

  if (touchedArchive && applied['archived_at'] != null) {
    cascadeArchiveToDescendants(owner, id, String(applied['archived_at']));
  }
  // Height-from-bottom: a re-parent or an archive can change levels above the node (it
  // gained/lost a descendant) and at the node itself.
  restampLevels(row.parent_id);
  restampLevels(id);
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

  // ONE transaction over the whole cascade. A crash between the root and its last
  // descendant would otherwise leave a live child under an archived parent — and
  // buildTree (:280-284) roots any node whose parent is filtered out, so that child
  // would silently resurface as a top-level goal. "Cascade as a unit" has to be atomic
  // to be true.
  sqlite.transaction(() => {
    sqlite.prepare(`UPDATE objectives SET archived_at = ? WHERE id = ? AND owner_id = ?`).run(now, id, owner);
    stampRow(sqlite, 'objective', id, ['archivedAt']);
    cascadeArchiveToDescendants(owner, id, now);
    // The parent just lost a live child: its height (and so its level) may drop, and its
    // rollup must stop counting the archived branch. recomputeProgress is new here — the
    // old deleteObjective omitted it, leaving a stale progress_cache behind.
    restampLevels(existing.parent_id);
    if (existing.parent_id) recomputeProgress(existing.parent_id);
  })();
  writeAudit({ ownerId: owner, actor: 'owner', action: 'archive', entity: `objective:${id}` });
  return { ok: true, parentId: existing.parent_id };
}

/**
 * Restore an archived objective and everything archived alongside it, clearing any
 * pending purge. THIS is the reversal: the row never left the table, so it is one
 * UPDATE — no id is re-minted and no FK or link tombstone was ever destroyed.
 */
export function restoreObjective(owner: string, id: string): RestoreResult {
  const existing = sqlite
    .prepare(`SELECT id, parent_id, archived_at, archive_root_id FROM objectives WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as
    | { id: string; parent_id: string | null; archived_at: string | null; archive_root_id: string | null }
    | undefined;
  if (!existing) return { ok: false, error: 'not_found' };

  // A cascaded member must be restored from its root. Restoring it alone would clear
  // its archived_at while its parent stayed archived — and buildTree (:280-284) roots
  // any node whose parent is filtered out, so the member would silently resurface as a
  // top-level goal. Refuse and name the root; the UI hides the action too.
  if (existing.archive_root_id) {
    return { ok: false, error: 'subtree_member', archiveRootId: existing.archive_root_id };
  }

  sqlite.transaction(() => {
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
  })();
  writeAudit({ ownerId: owner, actor: 'owner', action: 'restore', entity: `objective:${id}` });
  return { ok: true, parentId: existing.parent_id };
}

/** Restore/purge refuse on a cascaded member and name the root to act on instead. */
export type RestoreResult =
  | { ok: true; parentId: string | null }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'subtree_member'; archiveRootId: string };

export type PurgeResult =
  | { ok: true; purgeAfter: string | null }
  | { ok: false; error: 'not_found' | 'not_archived' | 'live_children' }
  | { ok: false; error: 'subtree_member'; archiveRootId: string };

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
    .prepare(`SELECT id, archived_at, archive_root_id FROM objectives WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as { id: string; archived_at: string | null; archive_root_id: string | null } | undefined;
  if (!row) return { ok: false, error: 'not_found' };
  if (!row.archived_at) return { ok: false, error: 'not_archived' };
  // Purge the subtree from its root, or the member would go while the root stayed —
  // and restoring the root afterwards could never bring the member back.
  if (row.archive_root_id) return { ok: false, error: 'subtree_member', archiveRootId: row.archive_root_id };
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
  const row = sqlite
    .prepare(`SELECT id, archive_root_id FROM objectives WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as { id: string; archive_root_id: string | null } | undefined;
  if (!row) return { ok: false, error: 'not_found' };
  // Symmetric with requestPurge: the deadline was stamped across the subtree, so the
  // undo belongs at the root. Cancelling from a member would spare only that member.
  if (row.archive_root_id) return { ok: false, error: 'subtree_member', archiveRootId: row.archive_root_id };
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
