import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { getTask } from '../services/tasks.js';
import {
  listFlightPlan,
  stage,
  updateEntry,
  unstageEntry,
  resetFlightPlan,
  type FlightPlanRow,
} from '../services/flight-plan.js';

/**
 * FlightPlanEntryType resolvers (Phase W · W5). Every resolver reuses
 * services/flight-plan.ts (Decision 3): the same owner-scoped staging functions the REST
 * /api/flight-plan routes call. Owner comes from `currentOwnerId()` (requireAuth), never
 * the client — the service filters every read/write by owner_id, so a cross-owner task id
 * is invisible (stage → task_not_found, update → not_staged, unstage → no-op).
 *
 * Mutations reproduce the REST side-effect envelope: the same SSE broadcast events
 * (flight_plan:updated / :reset) with the same payloads. writeAudit already fires INSIDE
 * the service (so REST + GraphQL emit identical audit rows) — none here.
 */
export const flightPlanResolvers = {
  Query: {
    flightPlan: () => listFlightPlan(currentOwnerId()),
  },

  Mutation: {
    stageFlightPlanTask: async (_p: unknown, args: { input: { taskId: string } }) => {
      const owner = currentOwnerId();
      const res = await stage(owner, { taskId: args.input.taskId });
      if (!res.ok) {
        if (res.error === 'task_not_found') throw new GraphQLError('task not found', { extensions: { code: 'NOT_FOUND' } });
        if (res.error === 'is_instance') throw new GraphQLError('stage the series template, not an instance', { extensions: { code: 'BAD_USER_INPUT' } });
        throw new GraphQLError('taskId is required', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'flight_plan:updated', { added: res.added });
      return { flightPlan: await listFlightPlan(owner), added: res.added, success: true };
    },

    stageFlightPlanPattern: async (_p: unknown, args: { input: { patternId: string } }) => {
      const owner = currentOwnerId();
      const res = await stage(owner, { patternId: args.input.patternId });
      if (!res.ok) {
        // A pattern stage can only fail as pattern_not_found (no instance/nothing paths).
        throw new GraphQLError('pattern not found', { extensions: { code: 'NOT_FOUND' } });
      }
      broadcast(owner, 'flight_plan:updated', { added: res.added });
      return { flightPlan: await listFlightPlan(owner), added: res.added, success: true };
    },

    updateFlightPlanEntry: async (_p: unknown, args: { input: { taskId: string; selected?: boolean | null; position?: number | null } }) => {
      const owner = currentOwnerId();
      const patch: { selected?: boolean; position?: number } = {};
      if (args.input.selected != null) patch.selected = args.input.selected;
      if (args.input.position != null) patch.position = args.input.position;
      const res = await updateEntry(owner, args.input.taskId, patch);
      if (!res.ok) throw new GraphQLError('not staged', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'flight_plan:updated', { task_id: args.input.taskId });
      return { flightPlan: await listFlightPlan(owner), success: true };
    },

    unstageFlightPlanEntry: async (_p: unknown, args: { input: { taskId: string } }) => {
      const owner = currentOwnerId();
      await unstageEntry(owner, args.input.taskId);
      broadcast(owner, 'flight_plan:updated', { removed: args.input.taskId });
      return { flightPlan: await listFlightPlan(owner), success: true };
    },

    resetFlightPlan: async () => {
      const owner = currentOwnerId();
      const { cleared } = await resetFlightPlan(owner);
      broadcast(owner, 'flight_plan:reset', { cleared });
      return { cleared, success: true };
    },
  },

  FlightPlanEntryType: {
    id: (e: FlightPlanRow) => e.task_id,
    sourceKind: (e: FlightPlanRow) => e.source_kind,
    // `task` is non-null (TaskType!). The flight_plan → tasks join in listFlightPlan only
    // returns entries whose (owner-scoped) task exists and the FK is ON DELETE CASCADE, so
    // getTask resolves it. Throw explicitly if it somehow can't (a concurrent delete
    // mid-query) rather than returning null into a non-null field — which would null the
    // whole [FlightPlanEntryType!]! list with an opaque error.
    task: async (e: FlightPlanRow) => {
      const t = await getTask(currentOwnerId(), e.task_id);
      if (!t) throw new GraphQLError('staged task not found', { extensions: { code: 'NOT_FOUND' } });
      return t;
    },
    // selected (bool) and position map by name via the default resolver.
  },
};
