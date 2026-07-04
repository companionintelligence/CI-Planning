import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { requestReplan } from '../engine/auto-defense.js';
import { taskToApi } from '../lib/serialize.js';
import {
  createTask as createTaskService,
  updateTask as updateTaskService,
  deleteTask as deleteTaskService,
  getTask, listTasks, countTasks, listSubtasks, countSubtasks, dependsOn as dependsOnService,
  type TaskRow, type CreateTaskInput as SvcCreateInput, type UpdateTaskInput as SvcUpdateInput,
} from '../services/tasks.js';
import { clampFirst, decodeIdCursor, buildIdConnection } from './pagination.js';

/**
 * TaskType resolvers (Phase W · W3.3b). Every resolver reuses services/tasks.ts
 * (Decision 3): the CRUD mutations call the SAME functions the REST routes call, and
 * the reads go through the owner-scoped getTask/listTasks/… added for this ticket.
 * Owner-scoping is read from `currentOwnerId()` (bound by requireAuth), NEVER trusted
 * from the client, so a cross-owner id is invisible (getTask → undefined → null).
 *
 * The mutation resolvers reproduce the REST side-effect envelope exactly (routes/
 * tasks.ts): the same broadcast(...) events with the same reason strings and the same
 * requestReplan(...) calls. `stampRow` versioning now lives INSIDE updateTask (W3.3b
 * commit 1), so mutations get it for free — no stamping here.
 *
 * Broadcast-payload fidelity: the REST route enriches the SSE payload with tags /
 * secondary_tags / depends_on / blocked. These resolvers broadcast `taskToApi(task)`
 * (the lean shape) instead — the SSE layer keys on `id`, so a client refetches the
 * full task on the event anyway; matching the route's richer enrichment would duplicate
 * read logic the mutation return value doesn't need. Documented divergence.
 */
type ConnArgs = { first?: number | null; after?: string | null; last?: number | null; before?: string | null };

/** async connection page → the sync shape GraphQL fields return. */
async function taskConnection(
  page: Promise<TaskRow[]>,
  limit: number,
  total: number,
) {
  return buildIdConnection(await page, limit, total);
}

/** Map a camelCase GraphQL CreateTaskInput to the service's snake_case CreateTaskInput. */
function toSvcCreate(input: Record<string, unknown>): SvcCreateInput {
  return {
    title: input.title as string,
    notes: input.notes == null ? undefined : (input.notes as string),
    priority: input.priority == null ? undefined : (input.priority as number),
    subtype: input.subtype ? (String(input.subtype).toLowerCase() as SvcCreateInput['subtype']) : undefined,
    estimated_minutes: input.estimatedMinutes == null ? undefined : (input.estimatedMinutes as number),
    due_at: input.dueAt == null ? undefined : (input.dueAt as string),
    scheduled_for: input.scheduledFor == null ? undefined : (input.scheduledFor as string),
    parent_id: input.parentId == null ? undefined : (input.parentId as string),
    tags: input.tags == null ? undefined : (input.tags as string[]),
    secondary_tags: input.secondaryTags == null ? undefined : (input.secondaryTags as string[]),
    depends_on: input.dependsOn == null ? undefined : (input.dependsOn as string[]),
  };
}

/** Map a camelCase GraphQL UpdateTaskInput to the service's UpdateTaskInput. Only keys
 *  the client actually sent are forwarded (an absent key stays absent = PATCH-preserve). */
function toSvcUpdate(input: Record<string, unknown>): SvcUpdateInput {
  const out: SvcUpdateInput = {};
  if ('title' in input) out.title = input.title as string;
  if ('notes' in input) out.notes = input.notes as string | null;
  if ('status' in input) out.status = input.status as string;
  if ('priority' in input) out.priority = input.priority as number;
  if ('subtype' in input && input.subtype != null) out.subtype = String(input.subtype).toLowerCase() as SvcUpdateInput['subtype'];
  if ('estimatedMinutes' in input) out.estimated_minutes = input.estimatedMinutes as number | null;
  if ('dueAt' in input) out.due_at = input.dueAt as string | null;
  if ('scheduledFor' in input) out.scheduled_for = input.scheduledFor as string | null;
  if ('completedAt' in input) out.completed_at = input.completedAt as string | null;
  if ('completed' in input) out.completed = input.completed as boolean;
  if ('parentId' in input) out.parent_id = input.parentId as string | null;
  if ('tags' in input) out.tags = input.tags as string[];
  if ('secondaryTags' in input) out.secondary_tags = input.secondaryTags as string[];
  if ('dependsOn' in input) out.depends_on = input.dependsOn as string[];
  return out;
}

export const taskResolvers = {
  Query: {
    task: async (_p: unknown, args: { id: string }) => {
      return (await getTask(currentOwnerId(), args.id)) ?? null;
    },
    tasks: (_p: unknown, args: ConnArgs & { status?: string | null }) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const after = decodeIdCursor(args.after);
      const status = args.status ?? undefined;
      return taskConnection(
        listTasks(owner, { status, after: after || undefined, limit: limit + 1 }),
        limit,
        countTasks(owner, status),
      );
    },
  },

  Mutation: {
    createTask: async (_p: unknown, args: { input: Record<string, unknown> }) => {
      const owner = currentOwnerId();
      const res = await createTaskService(owner, toSvcCreate(args.input));
      if (!res.ok) {
        if (res.error === 'title_required') throw new GraphQLError('title is required', { extensions: { code: 'BAD_USER_INPUT' } });
        // dependency_cycle mirrors REST's 409.
        throw new GraphQLError('dependency cycle', { extensions: { code: 'CONFLICT', detail: res.detail } });
      }
      broadcast(owner, 'task:created', taskToApi(res.task));
      requestReplan('task:created'); // B2: a new task can shift today's plan
      return { task: res.task, success: true };
    },

    updateTask: async (_p: unknown, args: { input: Record<string, unknown> & { id: string } }) => {
      const owner = currentOwnerId();
      const res = await updateTaskService(owner, args.input.id, toSvcUpdate(args.input));
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('task not found', { extensions: { code: 'NOT_FOUND' } });
        if (res.error === 'invalid_rule') throw new GraphQLError(res.message, { extensions: { code: 'BAD_USER_INPUT' } });
        // dependency_cycle: the column write already applied + was stamped inside the
        // service (commit 1); mirror REST's 409.
        throw new GraphQLError('dependency cycle', { extensions: { code: 'CONFLICT', detail: res.detail } });
      }
      broadcast(owner, 'task:updated', taskToApi(res.task));
      requestReplan('task:updated'); // B2: edits to priority/due/estimate can re-order the day
      return { task: res.task, success: true };
    },

    deleteTask: async (_p: unknown, args: { input: { id: string } }) => {
      const owner = currentOwnerId();
      const res = await deleteTaskService(owner, args.input.id);
      if (!res.ok) throw new GraphQLError('task not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'task:updated', taskToApi(res.task)); // REST DELETE emits task:updated (soft-delete)
      requestReplan('task:deleted'); // B2: a cancelled task frees its slot
      return { deletedId: args.input.id, success: true };
    },
  },

  TaskType: {
    subtype: (t: TaskRow) => (t.subtype ?? 'standard').toUpperCase(),
    parent: async (t: TaskRow) => (t.parentId ? (await getTask(currentOwnerId(), t.parentId)) ?? null : null),
    subtasks: (t: TaskRow, args: ConnArgs) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const after = decodeIdCursor(args.after);
      return taskConnection(
        listSubtasks(owner, t.id, { after: after || undefined, limit: limit + 1 }),
        limit,
        countSubtasks(owner, t.id),
      );
    },
    dependsOn: (t: TaskRow) => dependsOnService(currentOwnerId(), t.id),
  },
};
