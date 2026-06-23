import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Reusable Time-Block templates (Phase G, G3 + PR-B). Save a named, tagged Plan
 * container with a default duration — optionally **with the tasks that sat inside
 * it** (`tasks`: `{title,tag,estimated_minutes,offset_minutes}[]`) — then
 * re-instantiate it onto a day. Instantiating recreates the `block_kind='timeblock'`
 * Plan container and, for each saved task, a real task + its `block_kind='task'`
 * block at `start + offset_minutes`. Owner-scoped.
 */

interface TemplateTask {
  title: string;
  tag?: string | null;
  estimated_minutes?: number | null;
  offset_minutes?: number;
}
interface TemplateRow {
  id: string;
  owner_id: string;
  name: string;
  tag: string | null;
  default_minutes: number;
  tasks: string | null; // JSON TemplateTask[]
}

function parseTasks(raw: string | null): TemplateTask[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
const serializeTemplate = (t: TemplateRow) => ({
  id: t.id, owner_id: t.owner_id, name: t.name, tag: t.tag, default_minutes: t.default_minutes, tasks: parseTasks(t.tasks),
});
const serializeBlock = (b: Record<string, unknown>) => ({
  ...b,
  is_locked: !!b.is_locked,
  is_auto: !!b.is_auto,
  all_day: !!b.all_day,
});

export function blockTemplatesRouter() {
  const router = new Router();

  router.get('/api/block-templates', async (ctx) => {
    const rows = sqlite
      .prepare(`SELECT * FROM block_templates WHERE owner_id = ? ORDER BY name`)
      .all(currentOwnerId()) as TemplateRow[];
    ctx.body = { block_templates: rows.map(serializeTemplate) };
  });

  router.post('/api/block-templates', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { name?: string; tag?: string; default_minutes?: number; tasks?: TemplateTask[] };
    if (!body.name?.trim()) { ctx.status = 422; ctx.body = { error: 'name is required' }; return; }
    const tasksJson = Array.isArray(body.tasks) && body.tasks.length ? JSON.stringify(body.tasks) : null;
    const row = sqlite
      .prepare(`INSERT INTO block_templates (id, owner_id, name, tag, default_minutes, tasks) VALUES (uuid7(), ?, ?, ?, ?, ?) RETURNING *`)
      .get(currentOwnerId(), body.name.trim(), body.tag ?? null, body.default_minutes ?? 60, tasksJson) as TemplateRow;
    const out = serializeTemplate(row);
    broadcast(currentOwnerId(), 'block_template:created', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `block-template:${row.id}` });
    ctx.status = 201;
    ctx.body = { block_template: out };
  });

  router.delete('/api/block-templates/:id', async (ctx) => {
    const r = sqlite.prepare(`DELETE FROM block_templates WHERE id = ? AND owner_id = ?`).run(ctx.params.id, currentOwnerId());
    if (r.changes === 0) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'block_template:deleted', { id: ctx.params.id });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'delete', entity: `block-template:${ctx.params.id}` });
    ctx.body = { ok: true };
  });

  // Instantiate a template onto the day: the Plan container + its saved tasks.
  router.post('/api/block-templates/:id/instantiate', async (ctx) => {
    const owner = currentOwnerId();
    const t = sqlite.prepare(`SELECT * FROM block_templates WHERE id = ? AND owner_id = ?`).get(ctx.params.id, owner) as TemplateRow | undefined;
    if (!t) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as { start_at?: string; end_at?: string };
    if (!body.start_at) { ctx.status = 422; ctx.body = { error: 'start_at is required' }; return; }
    const base = Date.parse(body.start_at);
    const endAt = body.end_at ?? new Date(base + (t.default_minutes ?? 60) * 60_000).toISOString();

    const block = sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_locked, is_auto, source_kind, status)
         VALUES (uuid7(), ?, 'timeblock', 'scheduled', ?, ?, ?, 0, 0, 'manual', 'planned') RETURNING *`
      )
      .get(t.name, t.tag, body.start_at, endAt) as Record<string, unknown>;

    // Recreate the saved tasks (real task + its scheduled block at the saved offset).
    const insTask = sqlite.prepare(
      `INSERT INTO tasks (id, title, estimated_minutes, owner_id, status, priority, source_kind) VALUES (uuid7(), ?, ?, ?, 'open', 3, 'manual') RETURNING id`
    );
    const insBlock = sqlite.prepare(
      `INSERT INTO time_blocks (id, task_id, title, block_kind, tag, start_at, end_at, is_locked, is_auto, source_kind, status)
       VALUES (uuid7(), ?, ?, 'task', ?, ?, ?, 0, 0, 'manual', 'planned')`
    );
    for (const tk of parseTasks(t.tasks)) {
      const est = tk.estimated_minutes ?? 30;
      const id = (insTask.get(tk.title, tk.estimated_minutes ?? null, owner) as { id: string }).id;
      const s = new Date(base + (tk.offset_minutes ?? 0) * 60_000).toISOString();
      const e = new Date(Date.parse(s) + est * 60_000).toISOString();
      insBlock.run(id, tk.title, tk.tag ?? null, s, e);
    }

    const out = serializeBlock(block);
    broadcast(owner, 'block:created', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `block-template:${ctx.params.id}` });
    ctx.status = 201;
    ctx.body = { block: out };
  });

  return router;
}
