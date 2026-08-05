import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { getOwnedTag } from '../services/tags.js';
import { isValidISODate } from '../lib/dates.js';
import {
  getTodayGoal, getWeeklyGoals, getWeeklyGoalSlot, getDayNote, categoryColorToken, noteDates,
  upsertTodayGoal, upsertWeeklyGoal, upsertDayNote, toggleDone, deleteGoal,
  type ReflectionRow,
} from '../services/reflections.js';
import { toNode } from './tag-resolvers.js';

/**
 * ReflectionType resolvers (Phase W · W8b). Every resolver reuses services/reflections.ts
 * (Decision 3): the SAME owner-scoped functions the REST routes call. Owner comes from
 * `currentOwnerId()` (requireAuth), never the client — a cross-owner id/period is invisible
 * (reads return no rows; the composite key filters by owner_id).
 *
 * Mutations reproduce the REST SSE envelope (reflection:updated / reflection:deleted with
 * the {kind, period_key, position} payload); writeAudit already fires INSIDE the service,
 * so none here. The `evening` (Phase Z, flag-gated) kind stays REST-only — a niche
 * authorship flow, per the ticket.
 */

/** The Node id for a reflection row: 'kind:periodKey:position' (owner is implicit). */
function reflectionId(r: ReflectionRow): string {
  return `${r.kind}:${r.period_key}:${r.position}`;
}

export const reflectionResolvers = {
  Query: {
    reflections: async (_p: unknown, args: { period: string }) => {
      const owner = currentOwnerId();
      // `getWeeklyGoals` derives the ISO week via isoWeekKey(period), which throws on a
      // non-date — guard here so a bad input is a clean BAD_USER_INPUT, not a 500.
      if (!isValidISODate(args.period)) throw new GraphQLError('period must be YYYY-MM-DD', { extensions: { code: 'BAD_USER_INPUT' } });
      return {
        period: args.period,
        today: (await getTodayGoal(owner, args.period)) ?? null,
        weekly: await getWeeklyGoals(owner, args.period),
        note: (await getDayNote(owner, args.period)) ?? null,
      };
    },
    reflectionNoteDates: (_p: unknown, args: { from: string; to: string }) =>
      noteDates(currentOwnerId(), args.from, args.to),
  },

  Mutation: {
    setTodayGoal: async (_p: unknown, args: { input: { periodKey: string; body: string; categoryId?: string | null; sourceKind?: string | null; sourceRef?: string | null } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = await upsertTodayGoal(owner, {
        period_key: i.periodKey, body: i.body, category_id: i.categoryId ?? null,
        source_kind: i.sourceKind ?? undefined, source_ref: i.sourceRef ?? undefined,
      });
      if (!res.ok) throw new GraphQLError('periodKey is required', { extensions: { code: 'BAD_USER_INPUT' } });
      broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'today_goal', period_key: i.periodKey, position: 0 });
      return { reflection: res.row, deleted: res.action === 'delete', success: true };
    },

    setWeeklyGoal: async (_p: unknown, args: { input: { periodKey: string; position: number; body: string; categoryId?: string | null; sourceKind?: string | null; sourceRef?: string | null } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = await upsertWeeklyGoal(owner, i.position, {
        period_key: i.periodKey, body: i.body, category_id: i.categoryId ?? null,
        source_kind: i.sourceKind ?? undefined, source_ref: i.sourceRef ?? undefined,
      });
      if (!res.ok) {
        throw new GraphQLError(res.error === 'bad_position' ? 'position must be 0, 1, or 2' : 'periodKey is required', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'weekly_goal', period_key: i.periodKey, position: i.position });
      return { reflection: res.row, deleted: res.action === 'delete', success: true };
    },

    setDayNote: async (_p: unknown, args: { input: { periodKey: string; body: string } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = await upsertDayNote(owner, { period_key: i.periodKey, body: i.body });
      if (!res.ok) throw new GraphQLError('periodKey must be YYYY-MM-DD', { extensions: { code: 'BAD_USER_INPUT' } });
      broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'day_note', period_key: i.periodKey, position: 0 });
      return { reflection: res.row, deleted: res.action === 'delete', success: true };
    },

    toggleReflectionDone: async (_p: unknown, args: { input: { kind: string; periodKey: string; position: number; done: boolean } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = await toggleDone(owner, i.kind, i.position, { period_key: i.periodKey, done: i.done });
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('reflection not found', { extensions: { code: 'NOT_FOUND' } });
        const msg =
          res.error === 'bad_kind' ? 'kind must be today_goal or weekly_goal'
            : res.error === 'bad_position' ? 'invalid position for kind'
              : 'periodKey is required';
        throw new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'reflection:updated', { kind: i.kind, period_key: i.periodKey, position: i.position });
      // done-toggle mutates in place; return the refreshed row so the client sees done_at.
      // A weekly goal's periodKey is already the ISO-week key, so read it by exact key
      // (getWeeklyGoals would re-run isoWeekKey and throw on the week-key input).
      const row = i.kind === 'today_goal'
        ? await getTodayGoal(owner, i.periodKey)
        : await getWeeklyGoalSlot(owner, i.periodKey, i.position);
      return { reflection: row ?? null, deleted: false, success: true };
    },

    deleteReflection: async (_p: unknown, args: { input: { kind: string; periodKey: string; position: number } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = await deleteGoal(owner, i.kind, i.position, i.periodKey);
      if (!res.ok) {
        throw new GraphQLError(res.error === 'bad_kind' ? 'invalid kind' : 'periodKey is required', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'reflection:deleted', { kind: i.kind, period_key: i.periodKey, position: i.position });
      // `deleted` reflects whether a row actually existed (idempotent — still success:true).
      return { reflection: null, deleted: res.removed, success: true };
    },
  },

  ReflectionType: {
    id: (r: ReflectionRow) => reflectionId(r),
    periodKey: (r: ReflectionRow) => r.period_key,
    doneAt: (r: ReflectionRow) => r.done_at,
    sourceKind: (r: ReflectionRow) => r.source_kind,
    sourceRef: (r: ReflectionRow) => r.source_ref,
    createdAt: (r: ReflectionRow) => r.created_at,
    updatedAt: (r: ReflectionRow) => r.updated_at,
    colorToken: (r: ReflectionRow) => categoryColorToken(currentOwnerId(), r.category_id),
    category: async (r: ReflectionRow) => {
      if (!r.category_id) return null;
      const row = await getOwnedTag(currentOwnerId(), r.category_id);
      return row ? toNode(row) : null;
    },
    // kind, position, body map by name via the default resolver.
  },
};
