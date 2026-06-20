import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';

/**
 * Patterns (Phase G, ticket G1). Typed, reusable task collections — Routine ▢ /
 * Habit ◯ / Ritual △ (+ user-defined types). Tasks-only, many-to-many membership;
 * no own recurrence. Owner-scoped throughout.
 */

interface TypeRow {
  id: number;
  owner_id: number;
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
  id: number;
  owner_id: number;
  type_id: number | null;
  name: string;
  tag: string | null;
  notes: string | null;
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

function taskIdsOf(patternId: number): number[] {
  return (
    sqlite
      .prepare(`SELECT task_id FROM pattern_tasks WHERE pattern_id = ? ORDER BY position, task_id`)
      .all(patternId) as { task_id: number }[]
  ).map((r) => r.task_id);
}

const serializePattern = (p: PatternRow) => ({
  id: p.id,
  owner_id: p.owner_id,
  type_id: p.type_id,
  name: p.name,
  tag: p.tag,
  notes: p.notes,
  created_at: p.created_at,
  task_ids: taskIdsOf(p.id),
});

/** Replace a pattern's membership set with `taskIds` (in order). FK guards existence. */
function setMembers(patternId: number, taskIds: number[]) {
  sqlite.prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ?`).run(patternId);
  const ins = sqlite.prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`);
  taskIds.forEach((taskId, i) => ins.run(patternId, taskId, i));
}

export function patternsRouter() {
  const router = new Router();

  // ── Pattern types ──────────────────────────────────────────────────────────
  router.get('/api/pattern-types', async (ctx) => {
    const rows = sqlite
      .prepare(`SELECT * FROM pattern_types WHERE owner_id = ? ORDER BY is_builtin DESC, id`)
      .all(currentOwnerId()) as TypeRow[];
    ctx.body = { pattern_types: rows.map(serializeType) };
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
          `INSERT INTO pattern_types (owner_id, name, icon_shape, reminder_config, is_builtin, color_token, texture, default_est_minutes, notify)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING *`
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
    const id = Number(ctx.params.id);
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
    const id = Number(ctx.params.id);
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
      .get(Number(ctx.params.id), currentOwnerId()) as PatternRow | undefined;
    if (!p) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = { pattern: serializePattern(p) };
  });

  router.post('/api/patterns', async (ctx) => {
    const body = (ctx.request.body ?? {}) as {
      type_id?: number; name?: string; tag?: string; notes?: string; task_ids?: number[];
    };
    if (!body.name?.trim()) { ctx.status = 422; ctx.body = { error: 'name is required' }; return; }
    // Validate the type belongs to this owner.
    const type = body.type_id != null
      ? (sqlite.prepare(`SELECT id FROM pattern_types WHERE id = ? AND owner_id = ?`).get(body.type_id, currentOwnerId()) as { id: number } | undefined)
      : undefined;
    if (body.type_id != null && !type) { ctx.status = 422; ctx.body = { error: 'unknown pattern type' }; return; }

    const p = sqlite
      .prepare(`INSERT INTO patterns (owner_id, type_id, name, tag, notes) VALUES (?, ?, ?, ?, ?) RETURNING *`)
      .get(currentOwnerId(), body.type_id ?? null, body.name.trim(), body.tag ?? null, body.notes ?? null) as PatternRow;
    if (Array.isArray(body.task_ids) && body.task_ids.length) {
      try { setMembers(p.id, body.task_ids); }
      catch (err) { ctx.status = 400; ctx.body = { error: `bad task membership: ${(err as Error).message}` }; return; }
    }
    const out = serializePattern(p);
    broadcast(currentOwnerId(), 'pattern:created', out);
    ctx.status = 201;
    ctx.body = { pattern: out };
  });

  router.patch('/api/patterns/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const existing = sqlite.prepare(`SELECT * FROM patterns WHERE id = ? AND owner_id = ?`).get(id, currentOwnerId()) as
      | PatternRow
      | undefined;
    if (!existing) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as {
      type_id?: number | null; name?: string; tag?: string | null; notes?: string | null; task_ids?: number[];
    };
    const row = sqlite
      .prepare(`UPDATE patterns SET type_id = ?, name = ?, tag = ?, notes = ? WHERE id = ? RETURNING *`)
      .get(
        body.type_id !== undefined ? body.type_id : existing.type_id,
        body.name?.trim() ?? existing.name,
        body.tag !== undefined ? body.tag : existing.tag,
        body.notes !== undefined ? body.notes : existing.notes,
        id
      ) as PatternRow;
    if (Array.isArray(body.task_ids)) {
      try { setMembers(id, body.task_ids); }
      catch (err) { ctx.status = 400; ctx.body = { error: `bad task membership: ${(err as Error).message}` }; return; }
    }
    const out = serializePattern(row);
    broadcast(currentOwnerId(), 'pattern:updated', out);
    ctx.body = { pattern: out };
  });

  router.delete('/api/patterns/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const p = sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(id, currentOwnerId()) as
      | { id: number }
      | undefined;
    if (!p) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    sqlite.prepare(`DELETE FROM patterns WHERE id = ?`).run(id); // pattern_tasks cascade; tasks untouched
    broadcast(currentOwnerId(), 'pattern:deleted', { id });
    ctx.body = { ok: true };
  });

  // ── Membership ─────────────────────────────────────────────────────────────
  router.post('/api/patterns/:id/tasks', async (ctx) => {
    const patternId = Number(ctx.params.id);
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
    const patternId = Number(ctx.params.id);
    const owns = sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, currentOwnerId());
    if (!owns) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    sqlite.prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ? AND task_id = ?`).run(patternId, Number(ctx.params.taskId));
    broadcast(currentOwnerId(), 'pattern:updated', { id: patternId, task_ids: taskIdsOf(patternId) });
    ctx.body = { pattern_id: patternId, task_ids: taskIdsOf(patternId) };
  });

  return router;
}
