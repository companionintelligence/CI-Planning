import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { placePatternOnDay, validatePatternRule } from '../engine/patterns-place.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';
import { syncEntityTags, removeEntityTags, splitTagString } from '../services/tags.js';

/**
 * Patterns (Phase G, ticket G1). Typed, reusable task collections — Routine ▢ /
 * Habit ◯ / Ritual △ (+ user-defined types). Tasks-only, many-to-many membership;
 * no own recurrence. Owner-scoped throughout.
 */

interface TypeRow {
  id: string;
  owner_id: string;
  name: string;
  icon_shape: string;
  reminder_config: string | null;
  is_builtin: number;
  color_token: string | null;
  texture: string | null;
  default_est_minutes: number | null;
  notify: number;
}
interface PatternRow {
  id: string;
  owner_id: string;
  type_id: string | null;
  name: string;
  tag: string | null;
  notes: string | null;
  recurrence_rule: string | null;
  recurrence_dtstart: string | null;
  created_at: string;
}

/** Editable fields of a pattern type (the per-category display/config defaults). */
interface TypeInput {
  name?: string;
  icon_shape?: string;
  reminder_config?: unknown;
  color_token?: string | null;
  texture?: string | null;
  default_est_minutes?: number | null;
  notify?: boolean;
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const serializeType = (t: TypeRow) => ({
  id: t.id,
  owner_id: t.owner_id,
  name: t.name,
  icon_shape: t.icon_shape,
  reminder_config: parseJson(t.reminder_config),
  is_builtin: !!t.is_builtin,
  color_token: t.color_token,
  texture: t.texture,
  default_est_minutes: t.default_est_minutes,
  notify: !!t.notify,
});

function taskIdsOf(patternId: string): string[] {
  return (
    sqlite
      .prepare(`SELECT task_id FROM pattern_tasks WHERE pattern_id = ? ORDER BY position, task_id`)
      .all(patternId) as { task_id: string }[]
  ).map((r) => r.task_id);
}

const serializePattern = (p: PatternRow) => ({
  id: p.id,
  owner_id: p.owner_id,
  type_id: p.type_id,
  name: p.name,
  tag: p.tag,
  notes: p.notes,
  recurrence_rule: p.recurrence_rule,
  recurrence_dtstart: p.recurrence_dtstart,
  created_at: p.created_at,
  task_ids: taskIdsOf(p.id),
});

/** Replace a pattern's membership set with `taskIds` (in order). FK guards existence. */
function setMembers(patternId: string, taskIds: string[]) {
  sqlite.prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ?`).run(patternId);
  const ins = sqlite.prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`);
  taskIds.forEach((taskId, i) => ins.run(patternId, taskId, i));
}

/** The name of a pattern type by id (used for the Ritual-recurrence guard). */
function typeNameOf(typeId: string | null): string | null {
  if (typeId == null) return null;
  const row = sqlite.prepare(`SELECT name FROM pattern_types WHERE id = ?`).get(typeId) as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Validate + normalize a recurrence body on a pattern. Only Habit + Routine
 * types may carry a rule (Rituals are hidden in V1). If the caller omits
 * `recurrence_dtstart`, defaults to local-noon-as-UTC (mirrors the task-level
 * convention in engine/recurrence.ts — keeps every hit a safe ~12h away from
 * the local midnight boundary so a DST flip never moves a hit's local date).
 */
function buildRecurrenceFields(
  owner: string,
  typeId: string | null,
  rule: string | null | undefined,
  dtstart: string | null | undefined,
): { ok: true; rule: string | null; dtstart: string | null } | { ok: false; error: string } {
  if (rule === undefined && dtstart === undefined) return { ok: true, rule: undefined as unknown as null, dtstart: undefined as unknown as null };
  if (rule == null) return { ok: true, rule: null, dtstart: null }; // explicit clear
  const typeName = typeNameOf(typeId);
  if (typeName !== 'Habit' && typeName !== 'Routine') {
    return { ok: false, error: 'only Habit and Routine patterns can recur' };
  }
  const v = validatePatternRule(rule);
  if (!v.ok) return { ok: false, error: v.error };
  if (dtstart) return { ok: true, rule: v.rule, dtstart };
  const tz = (sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as { timezone: string | null } | undefined)?.timezone || serverTimezone();
  return { ok: true, rule: v.rule, dtstart: zonedWallTimeToUTC(localISODate(), '12:00', tz) };
}

export function patternsRouter() {
  const router = new Router();

  // ── Pattern types ──────────────────────────────────────────────────────────
  router.get('/api/pattern-types', async (ctx) => {
    const owner = currentOwnerId();
    const rows = sqlite
      .prepare(`SELECT * FROM pattern_types WHERE owner_id = ? ORDER BY is_builtin DESC, id`)
      .all(owner) as TypeRow[];
    // Rituals are hidden behind a per-owner feature flag (0024). The seeded
    // Ritual type stays in the DB so flipping the flag back on restores it.
    const enableRituals = !!(sqlite.prepare(`SELECT enable_rituals FROM scheduling_prefs WHERE owner_id = ?`)
      .get(owner) as { enable_rituals: number } | undefined)?.enable_rituals;
    const visible = enableRituals ? rows : rows.filter((r) => r.name !== 'Ritual');
    ctx.body = { pattern_types: visible.map(serializeType) };
  });

  router.post('/api/pattern-types', async (ctx) => {
    const body = (ctx.request.body ?? {}) as TypeInput;
    if (!body.name?.trim() || !body.icon_shape?.trim()) {
      ctx.status = 422;
      ctx.body = { error: 'name and icon_shape are required' };
      return;
    }
    try {
      const row = sqlite
        .prepare(
          `INSERT INTO pattern_types (id, owner_id, name, icon_shape, reminder_config, is_builtin, color_token, texture, default_est_minutes, notify)
           VALUES (uuid7(), ?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING *`
        )
        .get(
          currentOwnerId(),
          body.name.trim(),
          body.icon_shape.trim(),
          body.reminder_config != null ? JSON.stringify(body.reminder_config) : null,
          body.color_token ?? null,
          body.texture ?? null,
          body.default_est_minutes ?? null,
          body.notify ? 1 : 0
        ) as TypeRow;
      const out = serializeType(row);
      broadcast(currentOwnerId(), 'pattern_type:created', out);
      ctx.status = 201;
      ctx.body = { pattern_type: out };
    } catch (err) {
      ctx.status = 422;
      ctx.body = { error: `could not create type: ${(err as Error).message}` };
    }
  });

  router.patch('/api/pattern-types/:id', async (ctx) => {
    const id = ctx.params.id;
    const existing = sqlite
      .prepare(`SELECT * FROM pattern_types WHERE id = ? AND owner_id = ?`)
      .get(id, currentOwnerId()) as TypeRow | undefined;
    if (!existing) {
      ctx.status = 404;
      ctx.body = { error: 'not found' };
      return;
    }
    const body = (ctx.request.body ?? {}) as TypeInput;
    const name = body.name?.trim() ?? existing.name;
    const iconShape = body.icon_shape?.trim() ?? existing.icon_shape;
    const reminder = body.reminder_config !== undefined ? JSON.stringify(body.reminder_config) : existing.reminder_config;
    const colorToken = body.color_token !== undefined ? body.color_token : existing.color_token;
    const texture = body.texture !== undefined ? body.texture : existing.texture;
    const defaultEst = body.default_est_minutes !== undefined ? body.default_est_minutes : existing.default_est_minutes;
    const notify = body.notify !== undefined ? (body.notify ? 1 : 0) : existing.notify;
    const row = sqlite
      .prepare(
        `UPDATE pattern_types
            SET name = ?, icon_shape = ?, reminder_config = ?, color_token = ?, texture = ?, default_est_minutes = ?, notify = ?
          WHERE id = ? RETURNING *`
      )
      .get(name, iconShape, reminder, colorToken, texture, defaultEst, notify, id) as TypeRow;
    const out = serializeType(row);
    broadcast(currentOwnerId(), 'pattern_type:updated', out);
    ctx.body = { pattern_type: out };
  });

  router.delete('/api/pattern-types/:id', async (ctx) => {
    const id = ctx.params.id;
    const t = sqlite.prepare(`SELECT * FROM pattern_types WHERE id = ? AND owner_id = ?`).get(id, currentOwnerId()) as
      | TypeRow
      | undefined;
    if (!t) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    if (t.is_builtin) { ctx.status = 400; ctx.body = { error: 'built-in types cannot be deleted' }; return; }
    const inUse = sqlite.prepare(`SELECT COUNT(*) AS c FROM patterns WHERE type_id = ?`).get(id) as { c: number };
    if (inUse.c > 0) { ctx.status = 409; ctx.body = { error: 'type is in use by patterns' }; return; }
    sqlite.prepare(`DELETE FROM pattern_types WHERE id = ?`).run(id);
    broadcast(currentOwnerId(), 'pattern_type:deleted', { id });
    ctx.body = { ok: true };
  });

  // ── Patterns ───────────────────────────────────────────────────────────────
  router.get('/api/patterns', async (ctx) => {
    const rows = sqlite
      .prepare(`SELECT * FROM patterns WHERE owner_id = ? ORDER BY created_at DESC, id DESC`)
      .all(currentOwnerId()) as PatternRow[];
    ctx.body = { patterns: rows.map(serializePattern) };
  });

  router.get('/api/patterns/:id', async (ctx) => {
    const p = sqlite
      .prepare(`SELECT * FROM patterns WHERE id = ? AND owner_id = ?`)
      .get(ctx.params.id, currentOwnerId()) as PatternRow | undefined;
    if (!p) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = { pattern: serializePattern(p) };
  });

  router.post('/api/patterns', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as {
      type_id?: string; name?: string; tag?: string; notes?: string; task_ids?: string[];
      recurrence_rule?: string | null; recurrence_dtstart?: string | null;
    };
    if (!body.name?.trim()) { ctx.status = 422; ctx.body = { error: 'name is required' }; return; }
    // Validate the type belongs to this owner.
    const type = body.type_id != null
      ? (sqlite.prepare(`SELECT id FROM pattern_types WHERE id = ? AND owner_id = ?`).get(body.type_id, owner) as { id: string } | undefined)
      : undefined;
    if (body.type_id != null && !type) { ctx.status = 422; ctx.body = { error: 'unknown pattern type' }; return; }

    const rec = buildRecurrenceFields(owner, body.type_id ?? null, body.recurrence_rule, body.recurrence_dtstart);
    if (!rec.ok) { ctx.status = 422; ctx.body = { error: rec.error }; return; }

    const p = sqlite
      .prepare(`INSERT INTO patterns (id, owner_id, type_id, name, tag, notes, recurrence_rule, recurrence_dtstart) VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(owner, body.type_id ?? null, body.name.trim(), body.tag ?? null, body.notes ?? null,
           rec.rule === undefined ? null : rec.rule,
           rec.dtstart === undefined ? null : rec.dtstart) as PatternRow;
    if (Array.isArray(body.task_ids) && body.task_ids.length) {
      try { setMembers(p.id, body.task_ids); }
      catch (err) { ctx.status = 400; ctx.body = { error: `bad task membership: ${(err as Error).message}` }; return; }
    }
    // CON-3: mirror the routine's (denormalized) tag string into the normalized store.
    if (body.tag !== undefined) syncEntityTags('routine', p.id, splitTagString(body.tag));
    const out = serializePattern(p);
    broadcast(owner, 'pattern:created', out);
    ctx.status = 201;
    ctx.body = { pattern: out };
  });

  router.patch('/api/patterns/:id', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;
    const existing = sqlite.prepare(`SELECT * FROM patterns WHERE id = ? AND owner_id = ?`).get(id, owner) as
      | PatternRow
      | undefined;
    if (!existing) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as {
      type_id?: string | null; name?: string; tag?: string | null; notes?: string | null; task_ids?: string[];
      recurrence_rule?: string | null; recurrence_dtstart?: string | null;
    };
    const nextTypeId = body.type_id !== undefined ? body.type_id : existing.type_id;
    const rec = buildRecurrenceFields(owner, nextTypeId, body.recurrence_rule, body.recurrence_dtstart);
    if (!rec.ok) { ctx.status = 422; ctx.body = { error: rec.error }; return; }

    const row = sqlite
      .prepare(`UPDATE patterns SET type_id = ?, name = ?, tag = ?, notes = ?, recurrence_rule = ?, recurrence_dtstart = ? WHERE id = ? RETURNING *`)
      .get(
        nextTypeId,
        body.name?.trim() ?? existing.name,
        body.tag !== undefined ? body.tag : existing.tag,
        body.notes !== undefined ? body.notes : existing.notes,
        rec.rule === undefined ? existing.recurrence_rule : rec.rule,
        rec.dtstart === undefined ? existing.recurrence_dtstart : rec.dtstart,
        id
      ) as PatternRow;
    if (Array.isArray(body.task_ids)) {
      try { setMembers(id, body.task_ids); }
      catch (err) { ctx.status = 400; ctx.body = { error: `bad task membership: ${(err as Error).message}` }; return; }
    }
    // CON-3: keep the normalized store in sync when the tag string changes (null/'' clears).
    if (body.tag !== undefined) syncEntityTags('routine', id, splitTagString(body.tag));
    const out = serializePattern(row);
    broadcast(owner, 'pattern:updated', out);
    ctx.body = { pattern: out };
  });

  router.delete('/api/patterns/:id', async (ctx) => {
    const id = ctx.params.id;
    const p = sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(id, currentOwnerId()) as
      | { id: string }
      | undefined;
    if (!p) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    // Ritual-local fast tasks are owned by the pattern — delete them with it. Shared
    // real tasks are untouched (only the membership rows cascade).
    // CON-3 cascade: these tasks + the routine itself are HARD-deleted — drop their
    // tag rows first (the fast-task ids must be read before the DELETE).
    const fastTasks = sqlite
      .prepare(`SELECT id FROM tasks WHERE is_fast_task = 1 AND id IN (SELECT task_id FROM pattern_tasks WHERE pattern_id = ?)`)
      .all(id) as { id: string }[];
    for (const t of fastTasks) removeEntityTags('task', t.id);
    sqlite.prepare(`DELETE FROM tasks WHERE is_fast_task = 1 AND id IN (SELECT task_id FROM pattern_tasks WHERE pattern_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM patterns WHERE id = ?`).run(id); // pattern_tasks cascade; tasks untouched
    removeEntityTags('routine', id);
    broadcast(currentOwnerId(), 'pattern:deleted', { id });
    ctx.body = { ok: true };
  });

  // ── Membership ─────────────────────────────────────────────────────────────
  router.post('/api/patterns/:id/tasks', async (ctx) => {
    const patternId = ctx.params.id;
    const owns = sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, currentOwnerId());
    if (!owns) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as { task_id?: number; position?: number };
    if (body.task_id == null) { ctx.status = 422; ctx.body = { error: 'task_id is required' }; return; }
    try {
      sqlite
        .prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`)
        .run(patternId, body.task_id, body.position ?? 0);
    } catch (err) {
      ctx.status = 400; ctx.body = { error: `could not add task: ${(err as Error).message}` }; return;
    }
    broadcast(currentOwnerId(), 'pattern:updated', { id: patternId, task_ids: taskIdsOf(patternId) });
    ctx.body = { pattern_id: patternId, task_ids: taskIdsOf(patternId) };
  });

  router.delete('/api/patterns/:id/tasks/:taskId', async (ctx) => {
    const patternId = ctx.params.id;
    const owns = sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, currentOwnerId());
    if (!owns) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    sqlite.prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ? AND task_id = ?`).run(patternId, ctx.params.taskId);
    broadcast(currentOwnerId(), 'pattern:updated', { id: patternId, task_ids: taskIdsOf(patternId) });
    ctx.body = { pattern_id: patternId, task_ids: taskIdsOf(patternId) };
  });

  // ── Fast tasks (ritual-local, hidden from the global task list) ──────────────
  // A fast task is created *inside* a pattern: a lightweight `tasks` row flagged
  // `is_fast_task`, linked only to this pattern. Its estimate is predicted from the
  // pattern type's default (overridable via the dial / `estimated_minutes`).
  router.post('/api/patterns/:id/fast-tasks', async (ctx) => {
    const patternId = ctx.params.id;
    const owner = currentOwnerId();
    const pattern = sqlite.prepare(`SELECT id, type_id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, owner) as
      | { id: string; type_id: string | null }
      | undefined;
    if (!pattern) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as { title?: string; estimated_minutes?: number };
    if (!body.title?.trim()) { ctx.status = 422; ctx.body = { error: 'title is required' }; return; }
    const typeDefault = pattern.type_id != null
      ? (sqlite.prepare(`SELECT default_est_minutes AS m FROM pattern_types WHERE id = ?`).get(pattern.type_id) as { m: number | null } | undefined)?.m ?? null
      : null;
    const est = body.estimated_minutes ?? typeDefault ?? 15;
    const task = sqlite
      .prepare(
        `INSERT INTO tasks (id, title, estimated_minutes, is_fast_task, subtype, owner_id, status, priority, source_kind)
         VALUES (uuid7(), ?, ?, 1, 'quick', ?, 'open', 3, 'manual') RETURNING id, title, estimated_minutes`
      )
      .get(body.title.trim(), est, owner) as { id: string; title: string; estimated_minutes: number };
    const pos = (sqlite.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM pattern_tasks WHERE pattern_id = ?`).get(patternId) as { m: number }).m + 1;
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(patternId, task.id, pos);
    broadcast(owner, 'pattern:updated', { id: patternId, task_ids: taskIdsOf(patternId) });
    ctx.status = 201;
    ctx.body = { task: { id: task.id, title: task.title, estimated_minutes: task.estimated_minutes, is_fast_task: true, subtype: 'quick' } };
  });

  router.delete('/api/patterns/:id/fast-tasks/:taskId', async (ctx) => {
    const patternId = ctx.params.id;
    const taskId = ctx.params.taskId;
    const owner = currentOwnerId();
    if (!sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, owner)) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    // Delete the underlying task only when it's genuinely a fast task (membership
    // cascades). A shared real task just loses its membership.
    const isFast = sqlite.prepare(`SELECT id FROM tasks WHERE id = ? AND owner_id = ? AND is_fast_task = 1`).get(taskId, owner);
    if (isFast) {
      // CON-3 cascade: the fast task is HARD-deleted — drop its tag rows.
      removeEntityTags('task', taskId);
      sqlite.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
    }
    else sqlite.prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ? AND task_id = ?`).run(patternId, taskId);
    broadcast(owner, 'pattern:updated', { id: patternId, task_ids: taskIdsOf(patternId) });
    ctx.body = { ok: true };
  });

  // ── Promote-to-Routine (PR-C+, Phase E + F) ────────────────────────────────
  // Three sister endpoints share the same write path: a Routine-type pattern is
  // created (owner-scoped), then `task_ids` are added in order. Source-specific
  // logic — extracting tasks from a Plan, a Plan template, or a selection —
  // happens above the helper.
  function createRoutineWithTasks(name: string, taskIds: string[]): PatternRow {
    const owner = currentOwnerId();
    const routineType = sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Routine' AND owner_id = ?`).get(owner) as { id: string } | undefined;
    if (!routineType) throw new Error('no Routine pattern type for owner');
    const p = sqlite
      .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING *`)
      .get(owner, routineType.id, name) as PatternRow;
    if (taskIds.length) setMembers(p.id, taskIds);
    return p;
  }

  /** POST /api/patterns/promote-from-plan { plan_block_id, name? } — create a
   *  Routine from a Plan container's currently-attached member task blocks. */
  router.post('/api/patterns/promote-from-plan', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { plan_block_id?: number; name?: string };
    if (body.plan_block_id == null) { ctx.status = 422; ctx.body = { error: 'plan_block_id is required' }; return; }
    const plan = sqlite.prepare(`SELECT id, title, block_kind FROM time_blocks WHERE id = ?`).get(body.plan_block_id) as
      | { id: string; title: string; block_kind: string } | undefined;
    if (!plan || plan.block_kind !== 'timeblock') { ctx.status = 404; ctx.body = { error: 'plan not found' }; return; }
    const taskIds = (sqlite
      .prepare(`SELECT DISTINCT task_id FROM time_blocks WHERE parent_block_id = ? AND task_id IS NOT NULL`)
      .all(plan.id) as { task_id: string }[]).map((r) => r.task_id);
    const p = createRoutineWithTasks(body.name?.trim() || plan.title, taskIds);
    const out = serializePattern(p);
    broadcast(owner, 'pattern:created', out);
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
    const tpl = sqlite.prepare(`SELECT id, name, tasks FROM block_templates WHERE id = ? AND owner_id = ?`).get(body.template_id, owner) as
      | { id: string; name: string; tasks: string | null } | undefined;
    if (!tpl) { ctx.status = 404; ctx.body = { error: 'template not found' }; return; }
    interface TemplateTask { title: string; estimated_minutes?: number | null }
    let savedTasks: TemplateTask[] = [];
    try { savedTasks = JSON.parse(tpl.tasks ?? '[]'); if (!Array.isArray(savedTasks)) savedTasks = []; } catch { savedTasks = []; }

    const insTask = sqlite.prepare(`INSERT INTO tasks (id, title, estimated_minutes, owner_id, status, priority, source_kind) VALUES (uuid7(), ?, ?, ?, 'open', 3, 'manual') RETURNING id`);
    const taskIds: string[] = [];
    for (const t of savedTasks) {
      const id = (insTask.get(t.title, t.estimated_minutes ?? null, owner) as { id: string }).id;
      taskIds.push(id);
    }
    const p = createRoutineWithTasks(body.name?.trim() || tpl.name, taskIds);
    const out = serializePattern(p);
    broadcast(owner, 'pattern:created', out);
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
    const owned = sqlite.prepare(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND owner_id = ?`).all(...ids, owner) as { id: string }[];
    if (owned.length !== ids.length) { ctx.status = 422; ctx.body = { error: 'task ids must belong to the current owner' }; return; }
    const p = createRoutineWithTasks(body.name?.trim() || 'New routine', ids);
    const out = serializePattern(p);
    broadcast(owner, 'pattern:created', out);
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
    const pattern = sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(id, owner);
    if (!pattern) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as { date?: string; block_id?: string | null };
    const result = placePatternOnDay(owner, id, { date: body.date, blockId: body.block_id ?? null });

    // Return the freshly placed (or already-on-the-day pattern-marked) blocks
    // so the client can patch its block store without waiting on SSE.
    const blocks = sqlite
      .prepare(
        `SELECT * FROM time_blocks
          WHERE source_kind = 'pattern' AND source_ref = ?
            AND date(start_at) = date(?)
          ORDER BY start_at`
      )
      .all(String(id), `${result.date}T00:00:00`) as Record<string, unknown>[];
    ctx.body = {
      result,
      blocks: blocks.map((b) => ({ ...b, is_locked: !!b.is_locked, is_auto: !!b.is_auto, all_day: !!b.all_day })),
    };
  });

  return router;
}
