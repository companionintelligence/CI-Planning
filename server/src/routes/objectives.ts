import Router from '@koa/router';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { store } from '../db/store.js';
import { taskToApi } from '../lib/serialize.js';
import { getDependencies, blockedTaskIds } from '../engine/deps.js';
import { estimateObjectiveTaskMinutes } from '../agents/quickadd.js';
import { requestReplan } from '../engine/auto-defense.js';
import { taskTagNames, entityCategoryNames } from '../services/tags.js';
import { taskSecondaryTags, createTask, deleteTask } from '../services/tasks.js';
import { getEntityPeople } from '../services/people.js';
import {
  buildTree, createObjective, updateObjective,
  archiveObjective, restoreObjective, requestPurge, cancelPurge, listArchivedObjectiveRows,
  linkTaskToObjective, unlinkTaskFromObjective, moveTaskBetweenObjectives, recomputeObjective,
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
    if (ctx.query.archived === '1') { ctx.body = { objectives: await listArchivedObjectiveRows(owner) }; return; }
    ctx.body = { objectives: await buildTree(owner) };
  });

  router.post('/api/objectives', async (ctx) => {
    const owner = currentOwnerId();
    const res = await createObjective(owner, (ctx.request.body ?? {}) as Parameters<typeof createObjective>[1]);
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
    const res = await updateObjective(owner, ctx.params.id, (ctx.request.body ?? {}) as Parameters<typeof updateObjective>[2]);
    if (!res.ok) {
      if (res.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (res.error === 'parent_not_found') { ctx.status = 422; ctx.body = { error: 'parent_id not found' }; return; }
      if (res.error === 'cycle') { ctx.status = 422; ctx.body = { error: 'parent_id would create a cycle' }; return; }
      ctx.status = 422; ctx.body = { error: 'invalid objective update' }; return;
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
    const res = await archiveObjective(owner, ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(owner, 'objective:deleted', { id: ctx.params.id });
    ctx.body = { ok: true };
  });

  router.post('/api/objectives/:id/restore', async (ctx) => {
    const owner = currentOwnerId();
    const res = await restoreObjective(owner, ctx.params.id);
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
    const res = await requestPurge(owner, ctx.params.id);
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
    const res = await cancelPurge(owner, ctx.params.id);
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

  // Create a task directly in the objective and surface it in the main task list.
  // AI copies the source task's non-time settings and estimates this task's own duration.
  router.post('/api/objectives/:id/tasks/create', async (ctx) => {
    const owner = currentOwnerId();
    const objectiveId = ctx.params.id;
    const title = ((ctx.request.body ?? {}) as { title?: string }).title?.trim();
    if (!title) { ctx.status = 422; ctx.body = { error: 'title is required' }; return; }

    const objective = await store()
      .prepare(`SELECT id, source_task_id FROM objectives WHERE id = ? AND owner_id = ? AND archived_at IS NULL`)
      .get<{ id: string; source_task_id: string | null }>(objectiveId, owner);
    if (!objective) { ctx.status = 404; ctx.body = { error: 'objective not found' }; return; }

    const parent = objective.source_task_id
      ? await store().prepare(
          `SELECT id, title, due_at, priority, motivation, motivation_source,
                  texture_enabled, texture_color_token
             FROM tasks WHERE id = ? AND owner_id = ?`,
        ).get<{
          id: string; title: string; due_at: string | null; priority: number | null;
          motivation: 'me' | 'us' | 'them' | null; motivation_source: 'user' | 'llm' | null;
          texture_enabled: number | null; texture_color_token: string | null;
        }>(objective.source_task_id, owner)
      : undefined;

    const estimatedMinutes = await estimateObjectiveTaskMinutes(title, parent?.title).catch(() => 30);
    const [tags, secondaryTags, categories] = parent
      ? await Promise.all([taskTagNames(parent.id), taskSecondaryTags(parent.id), entityCategoryNames('task', parent.id)])
      : [[], [], []] as [string[], string[], string[]];
    const people: Awaited<ReturnType<typeof getEntityPeople>> = parent
      ? await getEntityPeople('task', parent.id)
      : { responsible: [], beneficiaries: [] };

    const created = await createTask(owner, {
      title,
      estimated_minutes: estimatedMinutes,
      priority: parent?.priority ?? 3,
      ...(parent?.due_at ? { due_at: parent.due_at } : {}),
      tags,
      secondary_tags: secondaryTags,
      categories,
      ...(parent ? {
        texture_enabled: parent.texture_enabled !== 0,
        texture_color_token: parent.texture_color_token,
        motivation: parent.motivation,
        ...(parent.motivation_source ? { motivation_source: parent.motivation_source } : {}),
        responsible_ids: people.responsible.map((p) => p.id),
        beneficiary_ids: people.beneficiaries.map((p) => p.id),
      } : {}),
      source_kind: 'agent',
      auto_generated: true,
      human_approved_at: null,
    });
    if (!created.ok) { ctx.status = 400; ctx.body = { error: 'title is required' }; return; }

    const linked = await linkTaskToObjective(owner, objectiveId, created.task.id);
    if (!linked.ok) {
      await deleteTask(owner, created.task.id);
      ctx.status = linked.error === 'objective_not_found' ? 404 : 422;
      ctx.body = { error: linked.error === 'objective_not_found' ? 'objective not found' : 'could not link task to objective' };
      return;
    }

    const personSets = await getEntityPeople('task', created.task.id);
    const out = {
      ...taskToApi(created.task),
      tags,
      secondary_tags: secondaryTags,
      categories,
      depends_on: await getDependencies(created.task.id),
      blocked: (await blockedTaskIds()).has(created.task.id),
      ...personSets,
      objective_id: objectiveId,
      objective_ids: [objectiveId],
    };
    broadcast(owner, 'task:created', out);
    broadcast(owner, 'objective:updated', { id: objectiveId });
    broadcast(owner, 'objective_task:updated', { id: linked.linkId });
    requestReplan('task:created');
    ctx.status = 201;
    ctx.body = { task: out };
  });

  router.post('/api/objectives/:id/tasks', async (ctx) => {
    const owner = currentOwnerId();
    const objId = ctx.params.id;
    const body = (ctx.request.body ?? {}) as { task_id?: string };
    const res = await linkTaskToObjective(owner, objId, body.task_id);
    if (!res.ok) {
      if (res.error === 'objective_not_found') { ctx.status = 404; ctx.body = { error: 'objective not found' }; return; }
      if (res.error === 'task_id_required') { ctx.status = 422; ctx.body = { error: 'task_id is required' }; return; }
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
    const { linkId } = await unlinkTaskFromObjective(owner, objId, taskId);
    broadcast(owner, 'objective:updated', { id: objId });
    if (linkId) broadcast(owner, 'objective_task:updated', { id: linkId });
    ctx.body = { ok: true };
  });

  router.post('/api/objectives/:id/tasks/:taskId/move', async (ctx) => {
    const owner = currentOwnerId();
    const sourceObjectiveId = ctx.params.id;
    const taskId = ctx.params.taskId;
    const targetObjectiveId = ((ctx.request.body ?? {}) as { target_objective_id?: string }).target_objective_id;
    if (!targetObjectiveId) { ctx.status = 422; ctx.body = { error: 'target_objective_id is required' }; return; }
    const res = await moveTaskBetweenObjectives(owner, sourceObjectiveId, targetObjectiveId, taskId);
    if (!res.ok) {
      if (res.error === 'objective_not_found' || res.error === 'task_not_found' || res.error === 'not_linked') {
        ctx.status = 404;
        ctx.body = { error: res.error === 'objective_not_found' ? 'objective not found' : res.error === 'task_not_found' ? 'task not found' : 'task is no longer linked to this objective' };
      } else {
        ctx.status = 422;
        ctx.body = { error: res.error === 'different_group' ? 'tasks can only move within the same objective group' : 'task is already in this objective' };
      }
      return;
    }
    broadcast(owner, 'objective:updated', { id: sourceObjectiveId });
    broadcast(owner, 'objective:updated', { id: targetObjectiveId });
    broadcast(owner, 'objective_task:updated', { id: res.sourceLinkId });
    broadcast(owner, 'objective_task:updated', { id: res.targetLinkId });
    broadcast(owner, 'task:updated', { id: taskId });
    ctx.body = { ok: true };
  });

  // Explicit trigger for tests and manual cache refresh; the nightly job does this for all.
  router.post('/api/objectives/:id/recompute', async (ctx) => {
    const res = await recomputeObjective(currentOwnerId(), ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = { ok: true };
  });

  return router;
}
