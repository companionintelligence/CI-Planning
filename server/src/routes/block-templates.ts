import Router from '@koa/router';
import { store } from '../db/store.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { applyTaskPlacementStatus, revertTaskPlacementStatus } from '../services/block-task-sync.js';
import { removeEntityTags } from '../services/tags.js';
import {
  parseTasks,
  serializeTemplate,
  serializeBlock,
  materializeTemplateTasks,
  listBlockTemplates,
  getBlockTemplate,
  createBlockTemplate,
  upsertBlockTemplateByName,
  updateBlockTemplate,
  deleteBlockTemplate,
} from '../services/block-templates.js';

/**
 * Reusable Time-Block templates (Phase G, G3 + PR-B). Save a named, tagged Plan
 * container with a default duration — optionally **with the tasks that sat inside
 * it** (`tasks`: `{title,tag,estimated_minutes,offset_minutes}[]`) — then
 * re-instantiate it onto a day. Instantiating recreates the `block_kind='timeblock'`
 * Plan container and, for each saved task, a real task + its `block_kind='task'`
 * block at `start + offset_minutes`. Owner-scoped.
 *
 * Phase W (Decision 3): template CRUD lives in services/block-templates.ts so REST +
 * GraphQL share one owner-scoped implementation; these handlers are thin shells over it.
 * instantiate + apply-to-block (which materialize real time_blocks/tasks) stay here and
 * reuse the shared helpers.
 */

export function blockTemplatesRouter() {
  const router = new Router();

  router.get('/api/block-templates', async (ctx) => {
    ctx.body = { block_templates: listBlockTemplates(currentOwnerId()).map(serializeTemplate) };
  });

  // AF-8: optional `upsert: true` routes "save as template" through the by-name
  // upsert so re-saving a block refreshes the existing template instead of
  // duplicating it. Convention: 201 + `{ block_template, updated: false }` when a
  // new row was created, 200 + `{ block_template, updated: true }` when an existing
  // same-named template was refreshed. Without the flag (absent/false) the handler
  // is byte-identical to the historical create-always path: 201 + `{ block_template }`
  // (no `updated` key).
  router.post('/api/block-templates', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { name?: string; tag?: string; default_minutes?: number; tasks?: unknown; upsert?: boolean };
    const owner = currentOwnerId();
    if (body.upsert === true) {
      const res = upsertBlockTemplateByName(owner, body as Parameters<typeof upsertBlockTemplateByName>[1]);
      if (!res.ok) { ctx.status = 422; ctx.body = { error: 'name is required' }; return; }
      const out = serializeTemplate(res.row);
      broadcast(owner, res.kind === 'updated' ? 'block_template:updated' : 'block_template:created', out);
      ctx.status = res.kind === 'updated' ? 200 : 201;
      ctx.body = { block_template: out, updated: res.kind === 'updated' };
      return;
    }
    const res = createBlockTemplate(owner, body as Parameters<typeof createBlockTemplate>[1]);
    if (!res.ok) { ctx.status = 422; ctx.body = { error: 'name is required' }; return; }
    const out = serializeTemplate(res.row);
    broadcast(owner, 'block_template:created', out);
    ctx.status = 201;
    ctx.body = { block_template: out };
  });

  // Edit a saved Time Block (name / tag / default duration). The saved tasks are
  // captured via "save as template"; this just renames/retags/retimes it.
  router.patch('/api/block-templates/:id', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { name?: string; tag?: string | null; default_minutes?: number };
    const res = updateBlockTemplate(owner, ctx.params.id, body);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      ctx.status = 422; ctx.body = { error: 'name is required' }; return;
    }
    const out = serializeTemplate(res.row);
    broadcast(owner, 'block_template:updated', out);
    ctx.body = { block_template: out };
  });

  router.delete('/api/block-templates/:id', async (ctx) => {
    const res = deleteBlockTemplate(currentOwnerId(), ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'block_template:deleted', { id: ctx.params.id });
    ctx.body = { ok: true };
  });

  // Instantiate a template onto the day: the Plan container + its saved tasks.
  router.post('/api/block-templates/:id/instantiate', async (ctx) => {
    const owner = currentOwnerId();
    const t = getBlockTemplate(owner, ctx.params.id);
    if (!t) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const body = (ctx.request.body ?? {}) as { start_at?: string; end_at?: string };
    if (!body.start_at) { ctx.status = 422; ctx.body = { error: 'start_at is required' }; return; }
    const base = Date.parse(body.start_at);
    const endAt = body.end_at ?? new Date(base + (t.default_minutes ?? 60) * 60_000).toISOString();

    const block = await store()
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, block_kind, block_type, tag, start_at, end_at, is_locked, is_auto, source_kind, status)
         VALUES (uuid7(), ?, ?, 'timeblock', 'scheduled', ?, ?, ?, 0, 0, 'manual', 'planned') RETURNING *`
      )
      .get<Record<string, unknown>>(owner, t.name, t.tag, body.start_at, endAt);
    if (!block) { ctx.status = 500; ctx.body = { error: 'insert returned no row' }; return; }

    // Recreate the saved tasks (real task + its scheduled block at the saved offset).
    // Loose (no parent) — matches the historical instantiate behavior.
    materializeTemplateTasks(owner, base, parseTasks(t.tasks), null);

    const out = serializeBlock(block);
    broadcast(owner, 'block:created', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `block-template:${ctx.params.id}` });
    ctx.status = 201;
    ctx.body = { block: out };
  });

  // Swap an EXISTING block's contents for this template's: clear the block's current
  // child task-blocks (their tasks return to the open backlog — not deleted) and
  // repopulate from the template, parented to the block and flipped to scheduled.
  router.post('/api/block-templates/:id/apply-to-block', async (ctx) => {
    const owner = currentOwnerId();
    const t = getBlockTemplate(owner, ctx.params.id);
    if (!t) { ctx.status = 404; ctx.body = { error: 'template not found' }; return; }
    const body = (ctx.request.body ?? {}) as { block_id?: string };
    if (!body.block_id) { ctx.status = 422; ctx.body = { error: 'block_id is required' }; return; }
    const block = await store()
      .prepare(`SELECT id, start_at FROM time_blocks WHERE id = ? AND owner_id = ? AND block_kind = 'timeblock'`)
      .get<{ id: string; start_at: string }>(body.block_id, owner);
    if (!block) { ctx.status = 404; ctx.body = { error: 'block not found (must be a Plan container)' }; return; }

    const touched = new Set<string>();
    await store().transaction(async () => {
      // 1. Clear current child task-blocks; their tasks revert to unscheduled.
      const children = await store()
        .prepare(`SELECT id, task_id, block_kind FROM time_blocks WHERE parent_block_id = ? AND owner_id = ?`)
        .all<{ id: string; task_id: string | null; block_kind: string }>(block.id, owner);
      for (const c of children) {
        if (c.task_id && c.block_kind === 'task') touched.add(c.task_id);
        removeEntityTags('time_block', c.id);
      }
      await store().prepare(`DELETE FROM time_blocks WHERE parent_block_id = ? AND owner_id = ?`).run(block.id, owner);
      for (const taskId of touched) revertTaskPlacementStatus(taskId, owner);

      // 2. Repopulate from the template, parented to the block + flipped to scheduled.
      const created = materializeTemplateTasks(owner, Date.parse(block.start_at), parseTasks(t.tasks), block.id);
      for (const id of created) { applyTaskPlacementStatus(id, owner); touched.add(id); }
    });

    broadcast(owner, 'block:updated', { id: block.id });
    for (const taskId of touched) broadcast(owner, 'task:updated', { id: taskId });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'apply', entity: `block-template:${ctx.params.id}:block:${block.id}` });
    ctx.body = { ok: true };
  });

  return router;
}
