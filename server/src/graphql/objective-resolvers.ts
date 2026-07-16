import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { getTask } from '../services/tasks.js';
import { getOwnedTag } from '../services/tags.js';
import {
  listObjectiveRows, getObjectiveRow, objectiveChildrenRows, objectiveTaskIds,
  createObjective, updateObjective, archiveObjective, linkTaskToObjective, unlinkTaskFromObjective,
  type ObjectiveRow, type CreateObjectiveInput, type UpdateObjectiveInput,
} from '../services/objectives.js';
import { toNode } from './tag-resolvers.js';

/**
 * ObjectiveType resolvers (Phase W · W8a). Reuse services/objectives.ts (Decision 3) —
 * the SAME owner-scoped functions the REST routes call (hierarchy leveling, cycle checks,
 * sync-versioned links, progress rollup all live there). Owner comes from
 * `currentOwnerId()`, never the client. Mutations reproduce the REST SSE envelope
 * (objective:created/updated/deleted + objective_task:updated); writeAudit + stampRow
 * already fire inside the service.
 */

/** Map a camelCase GraphQL create input to the service's snake_case input. */
function toCreate(input: Record<string, unknown>): CreateObjectiveInput {
  return {
    title: input.title as string,
    parent_id: input.parentId == null ? undefined : (input.parentId as string),
    horizon: input.horizon == null ? undefined : (input.horizon as string),
    status: input.status == null ? undefined : (input.status as string),
    cadence: input.cadence == null ? undefined : (input.cadence as string),
    target_date: input.targetDate == null ? undefined : (input.targetDate as string),
    category_id: input.categoryId == null ? undefined : (input.categoryId as string),
    priority: input.priority == null ? undefined : (input.priority as number),
    description: input.description == null ? undefined : (input.description as string),
  };
}

/** Map a camelCase GraphQL update input to the service's input, forwarding ONLY keys the
 *  client sent (an absent key stays absent = PATCH-preserve; explicit null clears). The
 *  service's field_ts stamping keys off exactly these snake keys. */
function toUpdate(input: Record<string, unknown>): UpdateObjectiveInput {
  const out: UpdateObjectiveInput = {};
  if ('title' in input) out.title = input.title as string;
  if ('parentId' in input) out.parent_id = input.parentId as string | null;
  if ('horizon' in input) out.horizon = input.horizon as string;
  if ('status' in input) out.status = input.status as string;
  if ('cadence' in input) out.cadence = input.cadence as string;
  if ('targetDate' in input) out.target_date = input.targetDate as string | null;
  if ('categoryId' in input) out.category_id = input.categoryId as string | null;
  if ('priority' in input) out.priority = input.priority as number;
  if ('description' in input) out.description = input.description as string | null;
  if ('completedAt' in input) out.completed_at = input.completedAt as string | null;
  return out;
}

export const objectiveResolvers = {
  Query: {
    objectives: () => listObjectiveRows(currentOwnerId()),
    // The graph is the LIVE graph: an archived objective resolves to null, matching
    // `objectives` (which filters) and what deleteObjective reports. The archive is
    // reachable via REST GET /api/objectives?archived=1; a GraphQL archive surface is
    // deliberately out of scope for 0129.
    objective: (_p: unknown, args: { id: string }) => {
      const row = getObjectiveRow(currentOwnerId(), args.id);
      return row && !row.archived_at ? row : null;
    },
  },

  Mutation: {
    createObjective: (_p: unknown, args: { input: Record<string, unknown> }) => {
      const owner = currentOwnerId();
      const res = createObjective(owner, toCreate(args.input));
      if (!res.ok) {
        throw new GraphQLError(res.error === 'title_required' ? 'title is required' : 'parent_id not found', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'objective:created', { id: res.row.id });
      return { objective: res.row, success: true };
    },

    updateObjective: (_p: unknown, args: { input: Record<string, unknown> & { id: string } }) => {
      const owner = currentOwnerId();
      const res = updateObjective(owner, args.input.id, toUpdate(args.input));
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('objective not found', { extensions: { code: 'NOT_FOUND' } });
        const msg =
          res.error === 'parent_not_found' ? 'parent_id not found'
            : res.error === 'cycle' ? 'parent_id would create a cycle'
              : 'cannot nest under a task-bearing objective — move its tasks first';
        throw new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'objective:updated', { id: args.input.id });
      return { objective: res.row, success: true };
    },

    // Archives rather than destroys, matching DELETE /api/objectives/:id — the two
    // surfaces share the service, so they must not disagree about what "delete" means.
    deleteObjective: (_p: unknown, args: { input: { id: string } }) => {
      const owner = currentOwnerId();
      const res = archiveObjective(owner, args.input.id);
      if (!res.ok) throw new GraphQLError('objective not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'objective:deleted', { id: args.input.id });
      return { deletedId: args.input.id, success: true };
    },

    linkObjectiveTask: (_p: unknown, args: { input: { objectiveId: string; taskId: string } }) => {
      const owner = currentOwnerId();
      const res = linkTaskToObjective(owner, args.input.objectiveId, args.input.taskId);
      if (!res.ok) {
        if (res.error === 'non_leaf') throw new GraphQLError('tasks can only be linked to a leaf objective, not a project or goal', { extensions: { code: 'BAD_USER_INPUT' } });
        // objective_not_found / task_not_found (task_id_required can't occur — taskId is ID!).
        throw new GraphQLError(res.error === 'task_not_found' ? 'task not found' : 'objective not found', { extensions: { code: 'NOT_FOUND' } });
      }
      broadcast(owner, 'objective:updated', { id: args.input.objectiveId });
      broadcast(owner, 'objective_task:updated', { id: res.linkId });
      return { objective: getObjectiveRow(owner, args.input.objectiveId) ?? null, success: true };
    },

    unlinkObjectiveTask: (_p: unknown, args: { input: { objectiveId: string; taskId: string } }) => {
      const owner = currentOwnerId();
      const { linkId } = unlinkTaskFromObjective(owner, args.input.objectiveId, args.input.taskId);
      broadcast(owner, 'objective:updated', { id: args.input.objectiveId });
      if (linkId) broadcast(owner, 'objective_task:updated', { id: linkId });
      return { objective: getObjectiveRow(owner, args.input.objectiveId) ?? null, success: true };
    },
  },

  ObjectiveType: {
    targetDate: (o: ObjectiveRow) => o.target_date,
    progressCache: (o: ObjectiveRow) => o.progress_cache,
    createdAt: (o: ObjectiveRow) => o.created_at,
    updatedAt: (o: ObjectiveRow) => o.updated_at,
    completedAt: (o: ObjectiveRow) => o.completed_at,
    parent: (o: ObjectiveRow) => (o.parent_id ? getObjectiveRow(currentOwnerId(), o.parent_id) ?? null : null),
    children: (o: ObjectiveRow) => objectiveChildrenRows(currentOwnerId(), o.id),
    // Linked tasks, re-fetched owner-scoped (a shared task that vanished is skipped, keeping
    // the non-null [TaskType!]! honest). Bounded per objective → N+1 acceptable.
    tasks: async (o: ObjectiveRow) => {
      const owner = currentOwnerId();
      const rows = await Promise.all(objectiveTaskIds(o.id).map((id) => getTask(owner, id)));
      return rows.filter((t): t is NonNullable<typeof t> => !!t);
    },
    category: (o: ObjectiveRow) => {
      if (!o.category_id) return null;
      const row = getOwnedTag(currentOwnerId(), o.category_id);
      return row ? toNode(row) : null;
    },
    // id, title, description, level, horizon, status, cadence, priority map by name.
  },
};
