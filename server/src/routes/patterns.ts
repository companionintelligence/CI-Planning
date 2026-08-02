import Router from '@koa/router';
import { store } from '../db/store.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { placePatternOnDay } from '../engine/patterns-place.js';
import { removeEntityTags, routineDerivedTagsByIds } from '../services/tags.js';
import { writeAudit } from '../lib/audit.js';
import {
  serializeType, serializePattern, taskIdsOf, setMembers, type PatternRow,
  listPatternTypeRows, createPatternType, updatePatternType, deletePatternType,
  listPatternRows, getPatternRow, createPattern, updatePattern, deletePattern,
  addPatternTask, removePatternTask,
  type TypeInput,
} from '../services/patterns.js';

/**
 * Patterns (Phase G, ticket G1). Typed, reusable task collections — Routine ▢ /
 * Habit ◯ / Ritual △ (+ user-defined types). Tasks-only, many-to-many membership;
 * no own recurrence. Owner-scoped throughout.
 *
 * Phase W · W6: the pattern-type + pattern CRUD lives in services/patterns.ts (shared
 * with GraphQL). These handlers are thin shells that map the service's discriminated
 * results to the exact REST status codes/messages and fire SSE. The engine-ish endpoints
 * (fast-tasks, promote-from-*, place-today) stay here and reuse the service's helpers.
 */
export function patternsRouter() {
  const router = new Router();

  // ── Pattern types ──────────────────────────────────────────────────────────
  router.get('/api/pattern-types', async (ctx) => {
    ctx.body = { pattern_types: (await listPatternTypeRows(currentOwnerId())).map(serializeType) };
  });

  router.post('/api/pattern-types', async (ctx) => {
    const owner = currentOwnerId();
    const res = await createPatternType(owner, (ctx.request.body ?? {}) as TypeInput);
    if (!res.ok) {
      if (res.error === 'missing_fields') { ctx.status = 422; ctx.body = { error: 'name and icon_shape are required' }; return; }
      ctx.status = 422; ctx.body = { error: `could not create type: ${res.message}` }; return;
    }
    const out = serializeType(res.row);
    broadcast(owner, 'pattern_type:created', out);
    ctx.status = 201;
    ctx.body = { pattern_type: out };
  });

  router.patch('/api/pattern-types/:id', async (ctx) => {
    const owner = currentOwnerId();
    const res = await updatePatternType(owner, ctx.params.id, (ctx.request.body ?? {}) as TypeInput);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const out = serializeType(res.row);
    broadcast(owner, 'pattern_type:updated', out);
    ctx.body = { pattern_type: out };
  });

  router.delete('/api/pattern-types/:id', async (ctx) => {
    const owner = currentOwnerId();
    const res = await deletePatternType(owner, ctx.params.id);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (res.error === 'builtin') { ctx.status = 400; ctx.body = { error: 'built-in types cannot be deleted' }; return; }
      ctx.status = 409; ctx.body = { error: 'type is in use by patterns' }; return;
    }
    broadcast(owner, 'pattern_type:deleted', { id: ctx.params.id });
    ctx.body = { ok: true };
  });

  // ── Patterns ───────────────────────────────────────────────────────────────
  router.get('/api/patterns', async (ctx) => {
    // AF-11: derived tags are batched across the whole list (one union query),
    // then handed to serializePattern per row — no per-routine N+1.
    const rows = await listPatternRows(currentOwnerId());
    const derived = routineDerivedTagsByIds(rows.map((r) => r.id));
    // serializePattern is async now (task_ids is a read), so the map yields promises —
    // without the Promise.all every entry would serialize as `{}`.
    ctx.body = { patterns: await Promise.all(rows.map((p) => serializePattern(p, derived.get(p.id)))) };
  });

  router.get('/api/patterns/:id', async (ctx) => {
    const p = await getPatternRow(currentOwnerId(), ctx.params.id);
    if (!p) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = { pattern: await serializePattern(p) };
  });

  // AF-11: a `tag` in the POST/PATCH body is accepted for API compat but IGNORED —
  // routines author no tags; their `directions`/`intentions` derive from member tasks.
  router.post('/api/patterns', async (ctx) => {
    const owner = currentOwnerId();
    const res = await createPattern(owner, (ctx.request.body ?? {}) as Parameters<typeof createPattern>[1]);
    if (!res.ok) {
      if (res.error === 'name_required') { ctx.status = 422; ctx.body = { error: 'name is required' }; return; }
      if (res.error === 'unknown_type') { ctx.status = 422; ctx.body = { error: 'unknown pattern type' }; return; }
      if (res.error === 'bad_recurrence') { ctx.status = 422; ctx.body = { error: res.message }; return; }
      ctx.status = 400; ctx.body = { error: `bad task membership: ${res.message}` }; return;
    }
    const out = await serializePattern(res.row);
    broadcast(owner, 'pattern:created', out);
    ctx.status = 201;
    ctx.body = { pattern: out };
  });

  router.patch('/api/patterns/:id', async (ctx) => {
    const owner = currentOwnerId();
    const res = await updatePattern(owner, ctx.params.id, (ctx.request.body ?? {}) as Parameters<typeof updatePattern>[2]);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (res.error === 'unknown_type') { ctx.status = 422; ctx.body = { error: 'unknown pattern type' }; return; }
      if (res.error === 'bad_recurrence') { ctx.status = 422; ctx.body = { error: res.message }; return; }
      ctx.status = 400; ctx.body = { error: `bad task membership: ${res.message}` }; return;
    }
    const out = await serializePattern(res.row);
    broadcast(owner, 'pattern:updated', out);
    ctx.body = { pattern: out };
  });

  router.delete('/api/patterns/:id', async (ctx) => {
    const owner = currentOwnerId();
    const res = await deletePattern(owner, ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(owner, 'pattern:deleted', { id: ctx.params.id });
    ctx.body = { ok: true };
  });

  // ── Membership ─────────────────────────────────────────────────────────────
  router.post('/api/patterns/:id/tasks', async (ctx) => {
    const owner = currentOwnerId();
    const patternId = ctx.params.id;
    const body = (ctx.request.body ?? {}) as { task_id?: number; position?: number };
    if (body.task_id == null) { ctx.status = 422; ctx.body = { error: 'task_id is required' }; return; }
    const res = await addPatternTask(owner, patternId, String(body.task_id), body.position ?? 0);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      ctx.status = 400; ctx.body = { error: `could not add task: ${res.message}` }; return;
    }
    broadcast(owner, 'pattern:updated', { id: patternId, task_ids: await taskIdsOf(patternId) });
    ctx.body = { pattern_id: patternId, task_ids: await taskIdsOf(patternId) };
  });

  router.delete('/api/patterns/:id/tasks/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    const patternId = ctx.params.id;
    const res = await removePatternTask(owner, patternId, ctx.params.taskId);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(owner, 'pattern:updated', { id: patternId, task_ids: await taskIdsOf(patternId) });
    ctx.body = { pattern_id: patternId, task_ids: await taskIdsOf(patternId) };
  });

  // ── Fast tasks (ritual-local, hidden from the global task list) ──────────────
  // A fast task is created *inside* a pattern: a lightweight `tasks` row flagged
  // `is_fast_task`, linked only to this pattern. Its estimate is predicted from the
  // pattern type's default (overridable via the dial / `estimated_minutes`).
  router.post('/api/patterns/:id/fast-tasks', async (ctx) => {
    const patternId = ctx.params.id;
    const owner = currentOwnerId();
    const pattern = await store().prepare(`SELECT id, type_id FROM patterns WHERE id = ? AND owner_id = ?`)
      .get<{ id: string; type_id: string | null }>(patternId, owner);
    if (!pattern) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as { title?: string; estimated_minutes?: number };
    if (!body.title?.trim()) { ctx.status = 422; ctx.body = { error: 'title is required' }; return; }
    const typeDefault = pattern.type_id != null
      ? (await store().prepare(`SELECT default_est_minutes AS m FROM pattern_types WHERE id = ?`).get<{ m: number | null }>(pattern.type_id))?.m ?? null
      : null;
    const est = body.estimated_minutes ?? typeDefault ?? 15;
    const task = (await store()
      .prepare(
        `INSERT INTO tasks (id, title, estimated_minutes, subtype, owner_id, status, priority, source_kind)
         VALUES (uuid7(), ?, ?, 'quick', ?, 'open', 3, 'manual') RETURNING id, title, estimated_minutes`
      )
      .get<{ id: string; title: string; estimated_minutes: number }>(body.title.trim(), est, owner))!;
    const pos = (await store().prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM pattern_tasks WHERE pattern_id = ?`).get<{ m: number }>(patternId))!.m + 1;
    await store().prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(patternId, task.id, pos);
    broadcast(owner, 'pattern:updated', { id: patternId, task_ids: await taskIdsOf(patternId) });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `task:${task.id}` });
    ctx.status = 201;
    ctx.body = { task: { id: task.id, title: task.title, estimated_minutes: task.estimated_minutes, subtype: 'quick' } };
  });

  router.delete('/api/patterns/:id/fast-tasks/:taskId', async (ctx) => {
    const patternId = ctx.params.id;
    const taskId = ctx.params.taskId;
    const owner = currentOwnerId();
    if (!(await store().prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, owner))) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    // Delete the underlying task only when it's genuinely a fast task (membership
    // cascades). A shared real task just loses its membership.
    const isFast = await store().prepare(`SELECT id FROM tasks WHERE id = ? AND owner_id = ? AND subtype = 'quick'`).get(taskId, owner);
    if (isFast) {
      // CON-3 cascade: the fast task is HARD-deleted — drop its tag rows.
      removeEntityTags('task', taskId);
      await store().prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
    }
    else await store().prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ? AND task_id = ?`).run(patternId, taskId);
    broadcast(owner, 'pattern:updated', { id: patternId, task_ids: await taskIdsOf(patternId) });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `task:${taskId}` });
    ctx.body = { ok: true };
  });

  // ── Promote-to-Routine (PR-C+, Phase E + F) ────────────────────────────────
  // Three sister endpoints share the same write path: a Routine-type pattern is
  // created (owner-scoped), then `task_ids` are added in order. Source-specific
  // logic — extracting tasks from a Plan, a Plan template, or a selection —
  // happens above the helper.
  async function createRoutineWithTasks(name: string, taskIds: string[]): Promise<PatternRow> {
    const owner = currentOwnerId();
    const routineType = await store().prepare(`SELECT id FROM pattern_types WHERE name = 'Routine' AND owner_id = ?`).get<{ id: string }>(owner);
    if (!routineType) throw new Error('no Routine pattern type for owner');
    const p = (await store()
      .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING *`)
      .get<PatternRow>(owner, routineType.id, name))!;
    if (taskIds.length) await setMembers(owner, p.id, taskIds);
    return p;
  }

  /** POST /api/patterns/promote-from-plan { plan_block_id, name? } — create a
   *  Routine from a Plan container's currently-attached member task blocks. */
  router.post('/api/patterns/promote-from-plan', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { plan_block_id?: number; name?: string };
    if (body.plan_block_id == null) { ctx.status = 422; ctx.body = { error: 'plan_block_id is required' }; return; }
    const plan = await store().prepare(`SELECT id, title, block_kind FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get<{ id: string; title: string; block_kind: string }>(body.plan_block_id, owner);
    if (!plan || plan.block_kind !== 'timeblock') { ctx.status = 404; ctx.body = { error: 'plan not found' }; return; }
    const taskIds = (await store()
      .prepare(`SELECT DISTINCT task_id FROM time_blocks WHERE parent_block_id = ? AND owner_id = ? AND task_id IS NOT NULL`)
      .all<{ task_id: string }>(plan.id, owner)).map((r) => r.task_id);
    const p = await createRoutineWithTasks(body.name?.trim() || plan.title, taskIds);
    const out = await serializePattern(p);
    broadcast(owner, 'pattern:created', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `routine:${p.id}` });
    ctx.status = 201;
    ctx.body = { pattern: out };
  });

  /** POST /api/patterns/promote-from-plan-template { template_id, name? } —
   *  create a Routine from a saved Plan template's tasks. Creates real tasks
   *  for each saved entry (the template only stores titles + estimates), then
   *  adds them as Routine members. */
  router.post('/api/patterns/promote-from-plan-template', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { template_id?: number; name?: string };
    if (body.template_id == null) { ctx.status = 422; ctx.body = { error: 'template_id is required' }; return; }
    const tpl = await store().prepare(`SELECT id, name, tasks FROM block_templates WHERE id = ? AND owner_id = ?`)
      .get<{ id: string; name: string; tasks: string | null }>(body.template_id, owner);
    if (!tpl) { ctx.status = 404; ctx.body = { error: 'template not found' }; return; }
    interface TemplateTask { title: string; estimated_minutes?: number | null }
    let savedTasks: TemplateTask[] = [];
    try { savedTasks = JSON.parse(tpl.tasks ?? '[]'); if (!Array.isArray(savedTasks)) savedTasks = []; } catch { savedTasks = []; }

    const insTask = store().prepare(`INSERT INTO tasks (id, title, estimated_minutes, owner_id, status, priority, source_kind) VALUES (uuid7(), ?, ?, ?, 'open', 3, 'manual') RETURNING id`);
    const taskIds: string[] = [];
    for (const t of savedTasks) {
      const id = (await insTask.get<{ id: string }>(t.title, t.estimated_minutes ?? null, owner))!.id;
      taskIds.push(id);
    }
    const p = await createRoutineWithTasks(body.name?.trim() || tpl.name, taskIds);
    const out = await serializePattern(p);
    broadcast(owner, 'pattern:created', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `routine:${p.id}` });
    ctx.status = 201;
    ctx.body = { pattern: out };
  });

  /** POST /api/patterns/promote-from-tasks { task_ids, name? } — create a
   *  Routine from a multi-selected set of existing tasks (Phase F: Shift+= hotkey). */
  router.post('/api/patterns/promote-from-tasks', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { task_ids?: string[]; name?: string };
    const ids = Array.isArray(body.task_ids) ? body.task_ids.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length === 0) { ctx.status = 422; ctx.body = { error: 'task_ids is required' }; return; }
    // Verify all tasks belong to this owner (defensive).
    const placeholders = ids.map(() => '?').join(',');
    const owned = await store().prepare(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND owner_id = ?`).all<{ id: string }>(...ids, owner);
    if (owned.length !== ids.length) { ctx.status = 422; ctx.body = { error: 'task ids must belong to the current owner' }; return; }
    const p = await createRoutineWithTasks(body.name?.trim() || 'New routine', ids);
    const out = await serializePattern(p);
    broadcast(owner, 'pattern:created', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `routine:${p.id}` });
    ctx.status = 201;
    ctx.body = { pattern: out };
  });

  // POST /api/patterns/:id/place-today — auto-place this pattern's tasks into
  // today's free gaps (PR-C+, Phase C). `block_id` scopes to a Plan's window +
  // makes the placed tasks members of that group (PR-C grouped movement).
  // Idempotent via a marker on time_blocks (source_kind='pattern', source_ref=id).
  router.post('/api/patterns/:id/place-today', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;
    const pattern = await store().prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(id, owner);
    if (!pattern) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as { date?: string; block_id?: string | null };
    const result = await placePatternOnDay(owner, id, { date: body.date, blockId: body.block_id ?? null });

    // Return the freshly placed (or already-on-the-day pattern-marked) blocks
    // so the client can patch its block store without waiting on SSE.
    const blocks = await store()
      .prepare(
        `SELECT * FROM time_blocks
          WHERE owner_id = ? AND source_kind = 'pattern' AND source_ref = ?
            AND date(start_at) = date(?)
          ORDER BY start_at`
      )
      .all<Record<string, unknown>>(owner, String(id), `${result.date}T00:00:00`);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'place', entity: `routine:${id}` });
    ctx.body = {
      result,
      blocks: blocks.map((b) => ({ ...b, is_locked: !!b.is_locked, is_auto: !!b.is_auto, all_day: !!b.all_day })),
    };
  });

  return router;
}
