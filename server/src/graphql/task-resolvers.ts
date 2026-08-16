import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { getEntityPeople } from '../services/people.js';
import { personToGraphql } from './people-resolvers.js';
import { broadcast } from '../routes/sse.js';
import { requestReplan } from '../engine/auto-defense.js';
import { taskToApi } from '../lib/serialize.js';
import { entityTagsFull, entityCategoryNames } from '../services/tags.js';
import { objectiveForTask } from '../services/objectives.js';
import {
  createTask as createTaskService,
  updateTask as updateTaskService,
  deleteTask as deleteTaskService,
  getTask, listTasks, countTasks, listSubtasks, countSubtasks, dependsOn as dependsOnService,
  updateTouchesSchedule,
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
    // Motivation (0141): wire enum → lowercase storage; a GraphQL caller is user testimony.
    motivation: input.motivation ? (String(input.motivation).toLowerCase() as SvcCreateInput['motivation']) : undefined,
    estimated_minutes: input.estimatedMinutes == null ? undefined : (input.estimatedMinutes as number),
    due_at: input.dueAt == null ? undefined : (input.dueAt as string),
    scheduled_for: input.scheduledFor == null ? undefined : (input.scheduledFor as string),
    parent_id: input.parentId == null ? undefined : (input.parentId as string),
    tags: input.tags == null ? undefined : (input.tags as string[]),
    secondary_tags: input.secondaryTags == null ? undefined : (input.secondaryTags as string[]),
    categories: input.categories == null ? undefined : (input.categories as string[]),
    texture_enabled: input.textureEnabled == null ? undefined : (input.textureEnabled as boolean),
    texture_color_token: input.textureColorToken == null ? undefined : (input.textureColorToken as string),
    depends_on: input.dependsOn == null ? undefined : (input.dependsOn as string[]),
    // People on work (0151) — same null-means-absent mapping as tags/categories above.
    responsible_ids: input.responsibleIds == null ? undefined : (input.responsibleIds as string[]),
    beneficiary_ids: input.beneficiaryIds == null ? undefined : (input.beneficiaryIds as string[]),
  };
}

/** Map a camelCase GraphQL UpdateTaskInput to the service's UpdateTaskInput. Only keys
 *  the client actually sent are forwarded (an absent key stays absent = PATCH-preserve). */
function toSvcUpdate(input: Record<string, unknown>): SvcUpdateInput {
  const out: SvcUpdateInput = {};

  if ('title' in input) {
    if (input.title === null) throw new GraphQLError('title cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.title = input.title as string;
  }
  if ('notes' in input) out.notes = input.notes as string | null;
  if ('status' in input) {
    if (input.status === null) throw new GraphQLError('status cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.status = input.status as string;
  }
  if ('priority' in input) {
    if (input.priority === null) throw new GraphQLError('priority cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.priority = input.priority as number;
  }
  if ('subtype' in input && input.subtype != null) out.subtype = String(input.subtype).toLowerCase() as SvcUpdateInput['subtype'];
  // Motivation (0141): absent preserves; explicit null clears value + source (the
  // textureColorToken 'in' idiom — null is a meaningful write here, not a skip).
  if ('motivation' in input)
    out.motivation = input.motivation == null ? null : (String(input.motivation).toLowerCase() as Exclude<SvcUpdateInput['motivation'], null | undefined>);
  if ('estimatedMinutes' in input) out.estimated_minutes = input.estimatedMinutes as number | null;
  if ('dueAt' in input) out.due_at = input.dueAt as string | null;
  if ('scheduledFor' in input) out.scheduled_for = input.scheduledFor as string | null;
  if ('completedAt' in input) out.completed_at = input.completedAt as string | null;
  if ('completed' in input) out.completed = input.completed as boolean;
  if ('parentId' in input) out.parent_id = input.parentId as string | null;
  if ('tags' in input) out.tags = input.tags as string[];
  // People on work (0151): present-means-write, so [] clears — the same 'in' idiom the
  // rest of this mapper uses for fields where an empty value is a real instruction.
  if ('responsibleIds' in input && input.responsibleIds != null) out.responsible_ids = input.responsibleIds as string[];
  if ('beneficiaryIds' in input && input.beneficiaryIds != null) out.beneficiary_ids = input.beneficiaryIds as string[];
  if ('secondaryTags' in input) out.secondary_tags = input.secondaryTags as string[];
  // Phase B: null is treated as absent — clearing is expressed by [] (REST contract).
  if ('categories' in input && input.categories != null) out.categories = input.categories as string[];
  if ('textureEnabled' in input) {
    if (input.textureEnabled === null) throw new GraphQLError('textureEnabled cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.texture_enabled = input.textureEnabled as boolean;
  }
  if ('textureColorToken' in input) out.texture_color_token = input.textureColorToken as string | null;
  if ('dependsOn' in input) out.depends_on = input.dependsOn as string[];
  return out;
}

export const taskResolvers = {
  Query: {
    task: async (_p: unknown, args: { id: string }) => {
      return (await getTask(currentOwnerId(), args.id)) ?? null;
    },
    tasks: async (_p: unknown, args: ConnArgs & { status?: string | null }) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const after = decodeIdCursor(args.after);
      const status = args.status ?? undefined;
      return taskConnection(
        listTasks(owner, { status, after: after || undefined, limit: limit + 1 }),
        limit,
        await countTasks(owner, status),
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
      // REQ2 reverse-sync parity with routes/tasks.ts: when a time/day/estimate edit moved
      // the task's placed block in lockstep, emit block:updated so other devices refresh it
      // (the GraphQL mutation was previously silent here → a stale block on other clients).
      // Emitted BEFORE task:updated to mirror the REST route's exact ordering (it broadcasts
      // the synced block first, then the task).
      if (res.syncedBlockId) broadcast(owner, 'block:updated', { id: res.syncedBlockId });
      // Task→block done-state mirror parity with REST: refresh each flipped block.
      for (const blockId of res.mirroredBlockIds) broadcast(owner, 'block:updated', { id: blockId });
      broadcast(owner, 'task:updated', taskToApi(res.task));
      // B2: only a scheduling-relevant column change can re-order the day (mirrors REST).
      if (updateTouchesSchedule(res.updatedFields)) requestReplan('task:updated');
      return { task: res.task, success: true };
    },

    deleteTask: async (_p: unknown, args: { input: { id: string } }) => {
      const owner = currentOwnerId();
      const res = await deleteTaskService(owner, args.input.id);
      if (!res.ok) throw new GraphQLError('task not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'task:updated', taskToApi(res.task)); // REST DELETE emits task:updated (soft-delete)
      for (const blockId of res.cancelledBlockIds) broadcast(owner, 'block:updated', { id: blockId });
      requestReplan('task:deleted'); // B2: a cancelled task frees its slot
      return { deletedId: args.input.id, success: true };
    },
  },

  TaskType: {
    subtype: (t: TaskRow) => (t.subtype ?? 'standard').toUpperCase(),
    // Motivation (0141): lowercase storage → SCREAMING enum; null (unlabeled) passes through.
    motivation: (t: TaskRow) => (t.motivation ? t.motivation.toUpperCase() : null),
    motivationSource: (t: TaskRow) => (t.motivationSource ? t.motivationSource.toUpperCase() : null),
    parent: async (t: TaskRow) => (t.parentId ? (await getTask(currentOwnerId(), t.parentId)) ?? null : null),
    subtasks: async (t: TaskRow, args: ConnArgs) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const after = decodeIdCursor(args.after);
      return taskConnection(
        listSubtasks(owner, t.id, { after: after || undefined, limit: limit + 1 }),
        limit,
        await countSubtasks(owner, t.id),
      );
    },
    dependsOn: (t: TaskRow) => dependsOnService(currentOwnerId(), t.id),
    // 0151. Owner-safe for the same reason `tags` is: this resolver only ever runs on
    // an already-owner-scoped task, so its entity_people rows are the owner's.
    responsible: async (t: TaskRow) => (await getEntityPeople('task', t.id)).responsible.map(personToGraphql),
    beneficiaries: async (t: TaskRow) => (await getEntityPeople('task', t.id)).beneficiaries.map(personToGraphql),
    // W4a Taggable forward edge. Owner-safe: this resolver only runs on an
    // already-owner-scoped task (task/tasks/parent/subtasks all go through getTask/
    // listTasks), so its entity_tags are the owner's. id/label/taggedAt map to
    // EntityTagType's fields via default resolvers — no EntityTagType resolver needed.
    tags: async (t: TaskRow) => (await entityTagsFull('task', t.id)).map((e) => ({ id: e.tagId, label: e.name, taggedAt: e.createdAt })),
    // Phase B: 1–3 category names, position order; texture default coerced like subtype.
    categories: async (t: TaskRow) => await entityCategoryNames('task', t.id),
    textureEnabled: (t: TaskRow) => t.textureEnabled ?? true,
    // W8a follow-up: the first objective this task is linked to (owner-scoped in the
    // service). The returned raw ObjectiveRow is shaped by ObjectiveType's field resolvers.
    objective: async (t: TaskRow) => (await objectiveForTask(currentOwnerId(), t.id)) ?? null,
  },
};
