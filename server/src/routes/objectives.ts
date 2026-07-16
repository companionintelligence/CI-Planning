import Router from '@koa/router';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import {
  buildTree, createObjective, updateObjective,
  archiveObjective, restoreObjective, requestPurge, cancelPurge, listArchivedObjectiveRows,
  linkTaskToObjective, unlinkTaskFromObjective, recomputeObjective,
} from '../services/objectives.js';

/**
 * Objectives (Phase N life-planning) — the Goal › Project › Objective tree. The hierarchy
 * leveling, cycle checks, sync-versioned task links, and progress rollup live in
 * services/objectives.ts (Phase W · W8a, shared with GraphQL); these handlers are thin
 * shells that fire the SSE broadcast the service can't (transport-agnostic).
 */
export function objectivesRouter() {
  const router = new Router();

  // ?archived=1 returns the ARCHIVE: a flat list (an archived subtree is not a tree
  // the panel can render meaningfully). The default tree excludes archived rows.
  router.get('/api/objectives', async (ctx) => {
    const owner = currentOwnerId();
    if (ctx.query.archived === '1') { ctx.body = { objectives: listArchivedObjectiveRows(owner) }; return; }
    ctx.body = { objectives: buildTree(owner) };
  });

  router.post('/api/objectives', async (ctx) => {
    const owner = currentOwnerId();
    const res = createObjective(owner, (ctx.request.body ?? {}) as Parameters<typeof createObjective>[1]);
    if (!res.ok) {
      if (res.error === 'title_required') { ctx.status = 422; ctx.body = { error: 'title is required' }; return; }
      ctx.status = 422; ctx.body = { error: 'parent_id not found' }; return;
    }
    broadcast(owner, 'objective:created', { id: res.row.id });
    ctx.status = 201;
    ctx.body = { objective: res.row };
  });

  router.patch('/api/objectives/:id', async (ctx) => {
    const owner = currentOwnerId();
    const res = updateObjective(owner, ctx.params.id, (ctx.request.body ?? {}) as Parameters<typeof updateObjective>[2]);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (res.error === 'parent_not_found') { ctx.status = 422; ctx.body = { error: 'parent_id not found' }; return; }
      if (res.error === 'cycle') { ctx.status = 422; ctx.body = { error: 'parent_id would create a cycle' }; return; }
      ctx.status = 422; ctx.body = { error: 'cannot nest under a task-bearing objective — move its tasks first' }; return;
    }
    broadcast(owner, 'objective:updated', { id: ctx.params.id });
    ctx.body = { objective: res.row };
  });

  // DELETE now ARCHIVES (owner request 2026-07-15) — the row is kept indefinitely and
  // is restorable. Permanent deletion is the explicit purge route below.
  // Still broadcasts objective:deleted: to every live client the objective has left
  // the tree, which is exactly what that event means to them.
  router.delete('/api/objectives/:id', async (ctx) => {
    const owner = currentOwnerId();
    const res = archiveObjective(owner, ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(owner, 'objective:deleted', { id: ctx.params.id });
    ctx.body = { ok: true };
  });

  router.post('/api/objectives/:id/restore', async (ctx) => {
    const owner = currentOwnerId();
    const res = restoreObjective(owner, ctx.params.id);
    if (!res.ok) {
      if (res.error === 'subtree_member') {
        ctx.status = 422;
        ctx.body = { error: 'restore the objective this was archived with', archive_root_id: res.archiveRootId };
        return;
      }
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    broadcast(owner, 'objective:created', { id: ctx.params.id }); // back in the tree
    ctx.body = { ok: true };
  });

  // Request permanent deletion — reversible until the deadline (PURGE_WINDOW_HOURS).
  router.post('/api/objectives/:id/purge', async (ctx) => {
    const owner = currentOwnerId();
    const res = requestPurge(owner, ctx.params.id);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (res.error === 'not_archived') { ctx.status = 422; ctx.body = { error: 'archive it first' }; return; }
      if (res.error === 'subtree_member') {
        ctx.status = 422;
        ctx.body = { error: 'delete the objective this was archived with', archive_root_id: res.archiveRootId };
        return;
      }
      ctx.status = 422; ctx.body = { error: 'objective still has live children' }; return;
    }
    broadcast(owner, 'objective:updated', { id: ctx.params.id });
    ctx.body = { ok: true, purge_after: res.purgeAfter };
  });

  // The reversal — cancel a pending permanent deletion.
  router.delete('/api/objectives/:id/purge', async (ctx) => {
    const owner = currentOwnerId();
    const res = cancelPurge(owner, ctx.params.id);
    if (!res.ok) {
      if (res.error === 'subtree_member') {
        ctx.status = 422;
        ctx.body = { error: 'undo from the objective this was archived with', archive_root_id: res.archiveRootId };
        return;
      }
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    broadcast(owner, 'objective:updated', { id: ctx.params.id });
    ctx.body = { ok: true };
  });

  router.post('/api/objectives/:id/tasks', async (ctx) => {
    const owner = currentOwnerId();
    const objId = ctx.params.id;
    const body = (ctx.request.body ?? {}) as { task_id?: string };
    const res = linkTaskToObjective(owner, objId, body.task_id);
    if (!res.ok) {
      if (res.error === 'objective_not_found') { ctx.status = 404; ctx.body = { error: 'objective not found' }; return; }
      if (res.error === 'task_id_required') { ctx.status = 422; ctx.body = { error: 'task_id is required' }; return; }
      if (res.error === 'non_leaf') { ctx.status = 422; ctx.body = { error: 'tasks can only be linked to a leaf objective, not a project or goal' }; return; }
      ctx.status = 404; ctx.body = { error: 'task not found' }; return;
    }
    broadcast(owner, 'objective:updated', { id: objId });
    broadcast(owner, 'objective_task:updated', { id: res.linkId });
    ctx.status = 201;
    ctx.body = { ok: true };
  });

  router.delete('/api/objectives/:id/tasks/:taskId', async (ctx) => {
    const owner = currentOwnerId();
    const { id: objId, taskId } = ctx.params;
    const { linkId } = unlinkTaskFromObjective(owner, objId, taskId);
    broadcast(owner, 'objective:updated', { id: objId });
    if (linkId) broadcast(owner, 'objective_task:updated', { id: linkId });
    ctx.body = { ok: true };
  });

  // Explicit trigger for tests and manual cache refresh; the nightly job does this for all.
  router.post('/api/objectives/:id/recompute', async (ctx) => {
    const res = recomputeObjective(currentOwnerId(), ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = { ok: true };
  });

  return router;
}
