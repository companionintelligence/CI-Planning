import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { getTask } from '../services/tasks.js';
import { routineDerivedTags } from '../services/tags.js';
import {
  listPatternTypeRows, getPatternTypeRow, createPatternType, updatePatternType, deletePatternType,
  listPatternRows, getPatternRow, createPattern, updatePattern, deletePattern,
  addPatternTask, removePatternTask,
  serializeType, serializePattern, taskIdsOf, parseJson,
  type TypeRow, type PatternRow, type TypeInput, type CreatePatternInput, type UpdatePatternInput,
} from '../services/patterns.js';

/**
 * PatternType + PatternKindType resolvers (Phase W · W6). Every resolver reuses
 * services/patterns.ts (Decision 3): the SAME owner-scoped functions the REST routes call.
 * Owner comes from `currentOwnerId()` (requireAuth), never the client — a cross-owner id
 * is invisible (get* → undefined → null; mutators → not_found).
 *
 * Mutations reproduce the REST SSE envelope (pattern:created/updated/deleted +
 * pattern_type:*). writeAudit already fires INSIDE the service, so none here.
 */

/** Map the camelCase GraphQL PatternKind input to the service's snake_case TypeInput.
 *  Only keys the client sent are forwarded (absent = PATCH-preserve on update). */
function toTypeInput(input: Record<string, unknown>): TypeInput {
  const out: TypeInput = {};
  if ('name' in input) out.name = input.name as string;
  if ('iconShape' in input) out.icon_shape = input.iconShape as string;
  if ('colorToken' in input) out.color_token = input.colorToken as string | null;
  if ('texture' in input) out.texture = input.texture as string | null;
  if ('defaultEstMinutes' in input) out.default_est_minutes = input.defaultEstMinutes as number | null;
  if ('notify' in input) out.notify = input.notify as boolean;
  if ('reminderConfig' in input) out.reminder_config = input.reminderConfig;
  return out;
}

/** Map the camelCase GraphQL Pattern input to the service's snake_case input. Only keys
 *  the client sent are forwarded (absent stays absent = PATCH-preserve; explicit null
 *  clears, exactly as the REST body does). */
function toPatternInput(input: Record<string, unknown>): CreatePatternInput & UpdatePatternInput {
  const out: CreatePatternInput & UpdatePatternInput = {};
  if ('name' in input) out.name = input.name as string;
  if ('kindId' in input) out.type_id = input.kindId as string | null;
  if ('tag' in input) out.tag = input.tag as string | null;
  if ('notes' in input) out.notes = input.notes as string | null;
  if ('taskIds' in input) out.task_ids = input.taskIds as string[];
  if ('recurrenceRule' in input) out.recurrence_rule = input.recurrenceRule as string | null;
  if ('recurrenceDtstart' in input) out.recurrence_dtstart = input.recurrenceDtstart as string | null;
  return out;
}

export const patternResolvers = {
  Query: {
    patternKinds: () => listPatternTypeRows(currentOwnerId()),
    patternKind: async (_p: unknown, args: { id: string }) => (await getPatternTypeRow(currentOwnerId(), args.id)) ?? null,
    patterns: () => listPatternRows(currentOwnerId()),
    pattern: async (_p: unknown, args: { id: string }) => (await getPatternRow(currentOwnerId(), args.id)) ?? null,
  },

  Mutation: {
    createPatternKind: async (_p: unknown, args: { input: Record<string, unknown> }) => {
      const owner = currentOwnerId();
      const res = await createPatternType(owner, toTypeInput(args.input));
      if (!res.ok) {
        throw new GraphQLError(res.error === 'missing_fields' ? 'name and iconShape are required' : `could not create type: ${res.message}`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      broadcast(owner, 'pattern_type:created', serializeType(res.row));
      return { patternKind: res.row, success: true };
    },

    updatePatternKind: async (_p: unknown, args: { input: Record<string, unknown> & { id: string } }) => {
      const owner = currentOwnerId();
      const res = await updatePatternType(owner, args.input.id, toTypeInput(args.input));
      if (!res.ok) throw new GraphQLError('pattern kind not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'pattern_type:updated', serializeType(res.row));
      return { patternKind: res.row, success: true };
    },

    deletePatternKind: async (_p: unknown, args: { input: { id: string } }) => {
      const owner = currentOwnerId();
      const res = await deletePatternType(owner, args.input.id);
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('pattern kind not found', { extensions: { code: 'NOT_FOUND' } });
        if (res.error === 'builtin') throw new GraphQLError('built-in types cannot be deleted', { extensions: { code: 'BAD_USER_INPUT' } });
        throw new GraphQLError('type is in use by patterns', { extensions: { code: 'CONFLICT' } });
      }
      broadcast(owner, 'pattern_type:deleted', { id: args.input.id });
      return { deletedId: args.input.id, success: true };
    },

    createPattern: async (_p: unknown, args: { input: Record<string, unknown> }) => {
      const owner = currentOwnerId();
      const res = await createPattern(owner, toPatternInput(args.input));
      if (!res.ok) {
        const msg =
          res.error === 'name_required' ? 'name is required'
            : res.error === 'unknown_type' ? 'unknown pattern kind'
              : res.error === 'bad_recurrence' ? (res.message ?? 'invalid recurrence')
                : `bad task membership: ${res.message}`;
        throw new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'pattern:created', await serializePattern(res.row));
      return { pattern: res.row, success: true };
    },

    updatePattern: async (_p: unknown, args: { input: Record<string, unknown> & { id: string } }) => {
      const owner = currentOwnerId();
      const res = await updatePattern(owner, args.input.id, toPatternInput(args.input));
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('pattern not found', { extensions: { code: 'NOT_FOUND' } });
        const msg =
          res.error === 'unknown_type' ? 'unknown pattern kind'
            : res.error === 'bad_recurrence' ? (res.message ?? 'invalid recurrence')
              : `bad task membership: ${res.message}`;
        throw new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'pattern:updated', await serializePattern(res.row));
      return { pattern: res.row, success: true };
    },

    deletePattern: async (_p: unknown, args: { input: { id: string } }) => {
      const owner = currentOwnerId();
      const res = await deletePattern(owner, args.input.id);
      if (!res.ok) throw new GraphQLError('pattern not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'pattern:deleted', { id: args.input.id });
      return { deletedId: args.input.id, success: true };
    },

    addPatternTask: async (_p: unknown, args: { input: { patternId: string; taskId: string; position?: number | null } }) => {
      const owner = currentOwnerId();
      const res = await addPatternTask(owner, args.input.patternId, args.input.taskId, args.input.position ?? 0);
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('pattern not found', { extensions: { code: 'NOT_FOUND' } });
        throw new GraphQLError(`could not add task: ${res.message}`, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'pattern:updated', { id: args.input.patternId, task_ids: await taskIdsOf(args.input.patternId) });
      return { pattern: (await getPatternRow(owner, args.input.patternId)) ?? null, success: true };
    },

    removePatternTask: async (_p: unknown, args: { input: { patternId: string; taskId: string } }) => {
      const owner = currentOwnerId();
      const res = await removePatternTask(owner, args.input.patternId, args.input.taskId);
      if (!res.ok) throw new GraphQLError('pattern not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'pattern:updated', { id: args.input.patternId, task_ids: await taskIdsOf(args.input.patternId) });
      return { pattern: (await getPatternRow(owner, args.input.patternId)) ?? null, success: true };
    },
  },

  PatternKindType: {
    iconShape: (t: TypeRow) => t.icon_shape,
    colorToken: (t: TypeRow) => t.color_token,
    defaultEstMinutes: (t: TypeRow) => t.default_est_minutes,
    notify: (t: TypeRow) => !!t.notify,
    isBuiltin: (t: TypeRow) => !!t.is_builtin,
    reminderConfig: (t: TypeRow) => parseJson(t.reminder_config),
    // name, texture map by name via the default resolver.
  },

  PatternType: {
    // AF-11 (D2): derived member-tag union. Patterns are a small hand-curated list
    // (see the Query comment in pattern.graphql), so per-node derivation here matches
    // the existing `tasks` resolver's bounded-N+1 stance; the REST list read batches.
    // The `??=` memo now caches a PROMISE, which is the point — both fields share one
    // read — but each resolver has to await it before reading a property off it.
    directions: async (p: PatternRow) => (await ((p as any).__derivedTags ??= routineDerivedTags(p.id))).directions,
    intentions: async (p: PatternRow) => (await ((p as any).__derivedTags ??= routineDerivedTags(p.id))).intentions,
    recurrenceRule: (p: PatternRow) => p.recurrence_rule,
    recurrenceDtstart: (p: PatternRow) => p.recurrence_dtstart,
    createdAt: (p: PatternRow) => p.created_at,
    kind: async (p: PatternRow) => (p.type_id ? (await getPatternTypeRow(currentOwnerId(), p.type_id)) ?? null : null),
    // Ordered member tasks; each re-fetched owner-scoped (a shared task that vanished is
    // skipped, keeping the non-null [TaskType!]! list honest). Bounded membership → N+1 fine.
    tasks: async (p: PatternRow) => {
      const owner = currentOwnerId();
      const rows = await Promise.all((await taskIdsOf(p.id)).map((id) => getTask(owner, id)));
      return rows.filter((t): t is NonNullable<typeof t> => !!t);
    },
    // name, tag, notes map by name via the default resolver.
  },
};
