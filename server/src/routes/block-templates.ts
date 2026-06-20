import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';

/**
 * Reusable Time-Block templates (Phase G, ticket G3). Save a named, tagged
 * container with a default duration, then re-instantiate it onto a day as a
 * `block_kind = 'timeblock'` container in `time_blocks`. Owner-scoped.
 */

interface TemplateRow {
  id: number;
  owner_id: number;
  name: string;
  tag: string | null;
  default_minutes: number;
}

const serializeBlock = (b: Record<string, unknown>) => ({
  ...b,
  is_locked: !!b.is_locked,
  is_auto: !!b.is_auto,
  all_day: !!b.all_day,
});

export function blockTemplatesRouter() {
  const router = new Router();

  router.get('/api/block-templates', async (ctx) => {
    ctx.body = {
      block_templates: sqlite
        .prepare(`SELECT * FROM block_templates WHERE owner_id = ? ORDER BY name`)
        .all(currentOwnerId()) as TemplateRow[],
    };
  });

  router.post('/api/block-templates', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { name?: string; tag?: string; default_minutes?: number };
    if (!body.name?.trim()) { ctx.status = 422; ctx.body = { error: 'name is required' }; return; }
    const row = sqlite
      .prepare(`INSERT INTO block_templates (owner_id, name, tag, default_minutes) VALUES (?, ?, ?, ?) RETURNING *`)
      .get(currentOwnerId(), body.name.trim(), body.tag ?? null, body.default_minutes ?? 60) as TemplateRow;
    broadcast(currentOwnerId(), 'block_template:created', row);
    ctx.status = 201;
    ctx.body = { block_template: row };
  });

  router.delete('/api/block-templates/:id', async (ctx) => {
    const r = sqlite.prepare(`DELETE FROM block_templates WHERE id = ? AND owner_id = ?`).run(Number(ctx.params.id), currentOwnerId());
    if (r.changes === 0) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'block_template:deleted', { id: Number(ctx.params.id) });
    ctx.body = { ok: true };
  });

  // Instantiate a template onto the day as a 'timeblock' container block.
  router.post('/api/block-templates/:id/instantiate', async (ctx) => {
    const t = sqlite
      .prepare(`SELECT * FROM block_templates WHERE id = ? AND owner_id = ?`)
      .get(Number(ctx.params.id), currentOwnerId()) as TemplateRow | undefined;
    if (!t) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as { start_at?: string; end_at?: string };
    if (!body.start_at) { ctx.status = 422; ctx.body = { error: 'start_at is required' }; return; }
    const endAt = body.end_at ?? new Date(Date.parse(body.start_at) + (t.default_minutes ?? 60) * 60_000).toISOString();
    const block = sqlite
      .prepare(
        `INSERT INTO time_blocks (title, block_kind, tag, start_at, end_at, is_locked, is_auto, source_kind, status)
         VALUES (?, 'timeblock', ?, ?, ?, 0, 0, 'manual', 'planned') RETURNING *`
      )
      .get(t.name, t.tag, body.start_at, endAt) as Record<string, unknown>;
    const out = serializeBlock(block);
    broadcast(currentOwnerId(), 'block:created', out);
    ctx.status = 201;
    ctx.body = { block: out };
  });

  return router;
}
