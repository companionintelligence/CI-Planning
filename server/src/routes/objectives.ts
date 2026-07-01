import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';

// The tree is Goal › Project › Objective, built bottom-up: a task-bearing leaf is
// an "objective", a node whose children are objectives is a "project", and one
// whose children are projects is a "goal". So level is derived from a node's
// HEIGHT (longest path down to a leaf descendant), not its depth from the root —
// a freshly-promoted standalone task-objective reads as "objective", and only
// becomes a project/goal once things are nested beneath it.
function heightBelow(id: string): number {
  const row = sqlite
    .prepare(
      `WITH RECURSIVE down(id, depth) AS (
         SELECT id, 0 FROM objectives WHERE id = ?
         UNION ALL
         SELECT o.id, down.depth + 1 FROM objectives o JOIN down ON o.parent_id = down.id
       )
       SELECT MAX(depth) AS d FROM down`
    )
    .get(id) as { d: number };
  return row.d;
}

function levelFromHeight(h: number): 'goal' | 'project' | 'objective' {
  return h === 0 ? 'objective' : h === 1 ? 'project' : 'goal';
}

/**
 * Link a task to an objective as an addressable, sync-versioned join row
 * (migration 0087). Idempotent: re-linking an existing (possibly tombstoned)
 * row flips it back to `linked = 1` and keeps its surrogate id. Stamps
 * `field_ts` so a stale queued op can't clobber the change. Returns the link id.
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
 * Unlink a task from an objective. Tombstones the join row (`linked = 0`) rather
 * than deleting it, so the unlink round-trips through field-LWW (a row deletion
 * can't merge). Stamps `field_ts`. Returns the link id, or null if none existed.
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

// Re-stamp `level` for a node AND its ancestors, since a structure change (create /
// re-parent / delete of a descendant) can change a parent's height and therefore its
// level. Walks UP the parent chain from `startId`, guarding against cycles.
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

// Detect a cycle: would setting obj.parent_id = proposedParent create a cycle?
// Returns true if proposedParent is a descendant of objId (which would cycle back).
function wouldCycle(objId: string, proposedParent: string): boolean {
  if (objId === proposedParent) return true;
  const row = sqlite
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? AS id
         UNION ALL
         SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
       )
       SELECT 1 FROM sub WHERE id = ? LIMIT 1`
    )
    .get(objId, proposedParent) as { 1: number } | undefined;
  return row !== undefined;
}

interface ObjectiveRow {
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

/**
 * For each objective, compute:
 *  - next_action: highest-priority incomplete task in the subtree
 *  - effective_target: max(target_date) across subtree
 *  - pace_expected: fraction of timeline elapsed (0..1 or null)
 *
 * Fetches all data up-front (no N+1): one objectives query, one tasks query
 * joining the recursive CTE for all objectives at once, then computes in JS.
 */
function buildTree(owner: string) {
  const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // All objectives for this owner.
  const objs = sqlite
    .prepare(`SELECT * FROM objectives WHERE owner_id = ? ORDER BY created_at`)
    .all(owner) as ObjectiveRow[];

  if (objs.length === 0) return [];

  // For each objective, find next_action and effective_target via recursive CTE.
  // We process per-objective (bounded by tree size, not N+1 over rows).
  const objIds = objs.map((o) => o.id);

  // Build id→objective map for fast lookup.
  const byId = new Map<string, ObjectiveRow & {
    next_action: null | { id: string; title: string; status: string; scheduled_date: string | null };
    effective_target: string | null;
    pace_expected: number | null;
    children: any[];
  }>();

  for (const o of objs) {
    byId.set(o.id, { ...o, next_action: null, effective_target: null, pace_expected: null, children: [] });
  }

  // Compute next_action + effective_target per objective.
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
                (SELECT MIN(start_at) FROM time_blocks tb WHERE tb.task_id = t.id AND DATE(tb.start_at) >= DATE('now')) AS scheduled_date
           FROM objective_tasks ot
           JOIN tasks t ON t.id = ot.task_id
           JOIN sub ON ot.objective_id = sub.id
          WHERE ot.linked = 1 AND t.status NOT IN ('done', 'cancelled', 'deferred')
          ORDER BY t.priority ASC, t.id ASC
          LIMIT 1`
      )
      .get(id) as { id: string; title: string; status: string; scheduled_date: string | null } | undefined;

    decorated.next_action = nextAction ?? null;

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
          WHERE target_date IS NOT NULL`
      )
      .get(id) as { et: string | null };

    decorated.effective_target = effectiveTarget.et ?? null;

    // pace_expected: (days since created) / (days from created to effective_target), clamped 0..1
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

  // Nest children under parents.
  const roots: typeof byId extends Map<string, infer V> ? V[] : never[] = [];
  for (const o of byId.values()) {
    if (o.parent_id && byId.has(o.parent_id)) {
      byId.get(o.parent_id)!.children.push(o);
    } else {
      roots.push(o as any);
    }
  }

  return roots;
}

/**
 * Recompute progress_cache for an objective and all its ancestors (bounded
 * upward walk). Called after task links change or explicitly via POST /recompute.
 */
export function recomputeProgress(objectiveId: string): void {
  const now = new Date().toISOString();

  // Walk up the ancestor chain, recomputing each.
  let currentId: string | null = objectiveId;
  while (currentId) {
    const obj = sqlite
      .prepare(`SELECT id, parent_id FROM objectives WHERE id = ?`)
      .get(currentId) as { id: string; parent_id: string | null } | undefined;
    if (!obj) break;

    // Compute estimate-weighted completion for directly-linked tasks. A cancelled
    // (soft-deleted) task is dropped entirely — neither done nor remaining — so
    // abandoning tasks never inflates the bar (it would if 'cancelled' counted as done).
    const tasks = sqlite
      .prepare(
        `SELECT t.estimated_minutes, t.status
           FROM objective_tasks ot JOIN tasks t ON t.id = ot.task_id
          WHERE ot.objective_id = ? AND ot.linked = 1 AND t.status != 'cancelled'`
      )
      .all(obj.id) as { estimated_minutes: number | null; status: string }[];

    // Also factor in children's progress_cache (weighted by null-safing).
    const children = sqlite
      .prepare(`SELECT progress_cache FROM objectives WHERE parent_id = ?`)
      .all(obj.id) as { progress_cache: number | null }[];

    const allNull =
      tasks.length === 0 &&
      children.every((c) => c.progress_cache === null);

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
        // Add children as weighted pseudo-tasks (average of their estimates if unknown, use count).
        for (const c of children) {
          if (c.progress_cache !== null) {
            // Treat each child as 1 "unit" weight contribution.
            total += 1;
            done += c.progress_cache;
          }
        }
        progress = total > 0 ? done / total : null;
      } else {
        // Count-based fallback.
        const doneCount = tasks.filter((t) => t.status === 'done').length;
        const totalTasks = tasks.length + children.filter((c) => c.progress_cache !== null).length;
        const childDone = children.reduce((s, c) => s + (c.progress_cache ?? 0), 0);
        progress = totalTasks > 0 ? (doneCount + childDone) / totalTasks : null;
      }
    }

    sqlite
      .prepare(`UPDATE objectives SET progress_cache = ?, updated_at = ? WHERE id = ?`)
      .run(progress ?? null, now, obj.id);

    currentId = obj.parent_id;
  }
}

export function objectivesRouter() {
  const router = new Router();

  // ── GET /api/objectives ──────────────────────────────────────────────────────
  router.get('/api/objectives', async (ctx) => {
    ctx.body = { objectives: buildTree(currentOwnerId()) };
  });

  // ── POST /api/objectives ─────────────────────────────────────────────────────
  router.post('/api/objectives', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as {
      title?: string;
      parent_id?: string | null;
      horizon?: string;
      status?: string;
      cadence?: string;
      target_date?: string | null;
      category_id?: string | null;
      priority?: number;
      description?: string;
    };

    if (!body.title?.trim()) { ctx.status = 422; ctx.body = { error: 'title is required' }; return; }

    // Validate parent_id — must belong to this owner.
    if (body.parent_id) {
      const parent = sqlite
        .prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`)
        .get(body.parent_id, owner);
      if (!parent) { ctx.status = 422; ctx.body = { error: 'parent_id not found' }; return; }
    }

    const id = newId();
    const now = new Date().toISOString();

    sqlite.prepare(`
      INSERT INTO objectives
        (id, owner_id, parent_id, title, description, horizon, status,
         cadence, target_date, category_id, priority, created_at, updated_at, level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, owner, body.parent_id ?? null, body.title.trim(), body.description ?? null,
      body.horizon ?? 'none', body.status ?? 'active', body.cadence ?? 'none',
      body.target_date ?? null, body.category_id ?? null, body.priority ?? 3, now, now,
      'objective', // placeholder — a childless new node is a leaf 'objective'; re-stamp below
    );

    // Re-stamp the new node + its ancestors: giving a parent a new child can raise
    // the parent's height (e.g. its first child turns a leaf 'objective' into a 'project').
    restampLevels(id);

    // Sync: stamp field_ts for the created fields so an older queued op can't clobber them.
    stampRow(sqlite, 'objective', id, [
      'title', 'description', 'parentId', 'horizon', 'status', 'cadence',
      'targetDate', 'categoryId', 'priority',
    ]);

    const obj = sqlite.prepare(`SELECT * FROM objectives WHERE id = ?`).get(id);
    broadcast(owner, 'objective:created', { id });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `objective:${id}` });
    ctx.status = 201;
    ctx.body = { objective: obj };
  });

  // ── PATCH /api/objectives/:id ────────────────────────────────────────────────
  router.patch('/api/objectives/:id', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;

    const existing = sqlite
      .prepare(`SELECT * FROM objectives WHERE id = ? AND owner_id = ?`)
      .get(id, owner) as ObjectiveRow | undefined;
    if (!existing) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const body = (ctx.request.body ?? {}) as {
      title?: string;
      parent_id?: string | null;
      horizon?: string;
      status?: string;
      cadence?: string;
      target_date?: string | null;
      category_id?: string | null;
      priority?: number;
      description?: string;
      completed_at?: string | null;
    };

    // Validate parent_id cycle check.
    if ('parent_id' in body && body.parent_id != null) {
      const parent = sqlite
        .prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`)
        .get(body.parent_id, owner);
      if (!parent) { ctx.status = 422; ctx.body = { error: 'parent_id not found' }; return; }
      if (wouldCycle(id, body.parent_id)) {
        ctx.status = 422; ctx.body = { error: 'parent_id would create a cycle' }; return;
      }
      // Containment rule: tasks live only at the leaf (objective) level, so a node may
      // not be nested under a task-bearing objective (that parent would then hold both
      // tasks and sub-objectives). Group under a project/goal instead.
      const parentHasTasks = sqlite
        .prepare(`SELECT 1 FROM objective_tasks WHERE objective_id = ? AND linked = 1 LIMIT 1`)
        .get(body.parent_id);
      if (parentHasTasks) {
        ctx.status = 422;
        ctx.body = { error: 'cannot nest under a task-bearing objective — move its tasks first' };
        return;
      }
    }

    // Capture the pre-update parent so a re-parent can re-level the OLD ancestor chain
    // too (the old parent may lose height when this subtree leaves it).
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

    sqlite.prepare(`
      UPDATE objectives SET
        title = ?, description = ?, horizon = ?, status = ?, cadence = ?,
        target_date = ?, category_id = ?, priority = ?, parent_id = ?,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(
      patch.title, patch.description, patch.horizon, patch.status, patch.cadence,
      patch.target_date, patch.category_id, patch.priority, patch.parent_id,
      patch.completed_at, now, id, owner,
    );

    // Re-stamp levels from height (a re-parent can change this node, its new ancestors,
    // and — if it moved away — its old ancestors).
    restampLevels(id);
    if (oldParentId && oldParentId !== patch.parent_id) restampLevels(oldParentId);

    // Sync: stamp only the fields this PATCH actually carried, so a stale queued op
    // for those same fields loses the LWW comparison on arrival (unmentioned fields
    // keep their prior stamp so a concurrent edit to a different field still merges).
    const patchToCamel: Record<string, string> = {
      title: 'title', description: 'description', horizon: 'horizon', status: 'status',
      cadence: 'cadence', target_date: 'targetDate', category_id: 'categoryId',
      priority: 'priority', parent_id: 'parentId', completed_at: 'completedAt',
    };
    const stamped = Object.keys(body).map((k) => patchToCamel[k]).filter(Boolean);
    if (stamped.length > 0) stampRow(sqlite, 'objective', id, stamped);

    const obj = sqlite.prepare(`SELECT * FROM objectives WHERE id = ?`).get(id);
    broadcast(owner, 'objective:updated', { id });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `objective:${id}` });
    ctx.body = { objective: obj };
  });

  // ── DELETE /api/objectives/:id ───────────────────────────────────────────────
  router.delete('/api/objectives/:id', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;
    const existing = sqlite.prepare(`SELECT id, parent_id FROM objectives WHERE id = ? AND owner_id = ?`)
      .get(id, owner) as { id: string; parent_id: string | null } | undefined;
    if (!existing) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    sqlite.prepare(`DELETE FROM objectives WHERE id = ? AND owner_id = ?`).run(id, owner);
    // Losing a child can shorten the (former) parent's height → re-level its chain.
    restampLevels(existing.parent_id);
    broadcast(owner, 'objective:deleted', { id });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `objective:${id}` });
    ctx.body = { ok: true };
  });

  // ── POST /api/objectives/:id/tasks ──────────────────────────────────────────
  router.post('/api/objectives/:id/tasks', async (ctx) => {
    const owner = currentOwnerId();
    const objId = ctx.params.id;
    const body = (ctx.request.body ?? {}) as { task_id?: string };

    const obj = sqlite.prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`).get(objId, owner);
    if (!obj) { ctx.status = 404; ctx.body = { error: 'objective not found' }; return; }

    if (!body.task_id) { ctx.status = 422; ctx.body = { error: 'task_id is required' }; return; }

    // Containment rule: tasks live only at the leaf (objective) level, so a task may
    // only be linked to a node with no sub-objectives ("any task in a Goal must also be
    // part of a project and an objective").
    if (heightBelow(objId) > 0) {
      ctx.status = 422;
      ctx.body = { error: 'tasks can only be linked to a leaf objective, not a project or goal' };
      return;
    }

    const task = sqlite.prepare(`SELECT id FROM tasks WHERE id = ? AND owner_id = ?`).get(body.task_id, owner);
    if (!task) { ctx.status = 404; ctx.body = { error: 'task not found' }; return; }

    const linkId = linkObjectiveTask(objId, body.task_id);
    recomputeProgress(objId);
    broadcast(owner, 'objective:updated', { id: objId });
    if (linkId) broadcast(owner, 'objective_task:updated', { id: linkId });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'link', entity: `objective:${objId}:task:${body.task_id}` });
    ctx.status = 201;
    ctx.body = { ok: true };
  });

  // ── DELETE /api/objectives/:id/tasks/:taskId ─────────────────────────────────
  router.delete('/api/objectives/:id/tasks/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    const { id: objId, taskId } = ctx.params;
    const linkId = unlinkObjectiveTask(objId, taskId);
    recomputeProgress(objId);
    broadcast(owner, 'objective:updated', { id: objId });
    if (linkId) broadcast(owner, 'objective_task:updated', { id: linkId });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'unlink', entity: `objective:${objId}:task:${taskId}` });
    ctx.body = { ok: true };
  });

  // ── POST /api/objectives/:id/recompute ───────────────────────────────────────
  // Explicit trigger for tests and manual cache refresh; the nightly job does this
  // for all objectives as a safety net.
  router.post('/api/objectives/:id/recompute', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;
    const obj = sqlite.prepare(`SELECT id FROM objectives WHERE id = ? AND owner_id = ?`).get(id, owner);
    if (!obj) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    recomputeProgress(id);
    ctx.body = { ok: true };
  });

  return router;
}
