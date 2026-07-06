import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { taskToApi } from '../lib/serialize.js';
import { getTask } from '../services/tasks.js';
import {
  listPossibles,
  getPossible,
  promotePossible,
  dismissPossible,
  type PossibleTaskRow,
} from '../services/possibles.js';

/**
 * PossibleTaskType resolvers (Phase W · W9). Every resolver reuses services/possibles.ts
 * (Decision 3): the SAME owner-scoped functions the REST /api/possible-tasks routes call.
 * Owner comes from `currentOwnerId()` (requireAuth), never the client — a cross-owner id
 * is invisible (query → undefined → null; promote/dismiss → NOT_FOUND).
 *
 * Mutations reproduce the REST SSE envelope (possible:promoted with {id, task}, and
 * possible:dismissed with {id}). writeAudit + the best-effort auto-schedule already fire
 * INSIDE the service, so none here. There are no create/update mutations — possibles are
 * produced by ingest, matching the REST surface.
 *
 * The promote payload's `task` returns `getTask(owner, taskId)` (the canonical camelCase
 * row shape TaskType's field resolvers consume) rather than the raw drizzle insert row.
 */

export const possibleTaskResolvers = {
  Query: {
    possibleTasks: (_p: unknown, args: { status?: string | null }) =>
      listPossibles(currentOwnerId(), args.status ?? 'pending'),
    possibleTask: async (_p: unknown, args: { id: string }) =>
      (await getPossible(currentOwnerId(), args.id)) ?? null,
  },

  Mutation: {
    promotePossibleTask: async (
      _p: unknown,
      args: { input: { id: string; title?: string | null; dueAt?: string | null; priority?: number | null } },
    ) => {
      const owner = currentOwnerId();
      const res = await promotePossible(owner, args.input.id, {
        title: args.input.title ?? undefined,
        due_at: args.input.dueAt ?? undefined,
        priority: args.input.priority ?? undefined,
      });
      if (!res.ok) throw new GraphQLError('possible task not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'possible:promoted', { id: args.input.id, task: taskToApi(res.task) });
      // Return the canonical task shape TaskType consumes; re-read the possible so its
      // status reflects 'promoted' + promoted_task_id.
      const [task, possible] = await Promise.all([
        getTask(owner, res.taskId),
        getPossible(owner, args.input.id),
      ]);
      return { task: task ?? null, possibleTask: possible ?? null, success: true };
    },

    dismissPossibleTask: async (_p: unknown, args: { input: { id: string } }) => {
      const owner = currentOwnerId();
      const res = await dismissPossible(owner, args.input.id);
      if (!res.ok) throw new GraphQLError('possible task not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'possible:dismissed', { id: args.input.id });
      return { possibleTask: res.row, success: true };
    },
  },

  PossibleTaskType: {
    rawTitle: (p: PossibleTaskRow) => p.rawTitle,
    rawSummary: (p: PossibleTaskRow) => p.rawSummary,
    proposedDueAt: (p: PossibleTaskRow) => p.proposedDueAt,
    proposedPriority: (p: PossibleTaskRow) => p.proposedPriority,
    sourceKind: (p: PossibleTaskRow) => p.sourceKind,
    createdAt: (p: PossibleTaskRow) => p.createdAt,
    // `status`, `confidence`, `id` map by name via the default resolver.
    promotedTask: async (p: PossibleTaskRow) =>
      p.promotedTaskId ? (await getTask(currentOwnerId(), p.promotedTaskId)) ?? null : null,
  },
};
