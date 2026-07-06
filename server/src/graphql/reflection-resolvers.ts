import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { getOwnedTag } from '../services/tags.js';
import {
  getTodayGoal, getWeeklyGoals, getDayNote, categoryColorToken, noteDates,
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
    reflections: (_p: unknown, args: { period: string }) => {
      const owner = currentOwnerId();
      return {
        period: args.period,
        today: getTodayGoal(owner, args.period) ?? null,
        weekly: getWeeklyGoals(owner, args.period),
        note: getDayNote(owner, args.period) ?? null,
      };
    },
    reflectionNoteDates: (_p: unknown, args: { from: string; to: string }) =>
      noteDates(currentOwnerId(), args.from, args.to),
  },

  Mutation: {
    setTodayGoal: (_p: unknown, args: { input: { periodKey: string; body: string; categoryId?: string | null; sourceKind?: string | null; sourceRef?: string | null } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = upsertTodayGoal(owner, {
        period_key: i.periodKey, body: i.body, category_id: i.categoryId ?? null,
        source_kind: i.sourceKind ?? undefined, source_ref: i.sourceRef ?? undefined,
      });
      if (!res.ok) throw new GraphQLError('periodKey is required', { extensions: { code: 'BAD_USER_INPUT' } });
      broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'today_goal', period_key: i.periodKey, position: 0 });
      return { reflection: res.row, deleted: res.action === 'delete', success: true };
    },

    setWeeklyGoal: (_p: unknown, args: { input: { periodKey: string; position: number; body: string; categoryId?: string | null; sourceKind?: string | null; sourceRef?: string | null } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = upsertWeeklyGoal(owner, i.position, {
        period_key: i.periodKey, body: i.body, category_id: i.categoryId ?? null,
        source_kind: i.sourceKind ?? undefined, source_ref: i.sourceRef ?? undefined,
      });
      if (!res.ok) {
        throw new GraphQLError(res.error === 'bad_position' ? 'position must be 0, 1, or 2' : 'periodKey is required', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'weekly_goal', period_key: i.periodKey, position: i.position });
      return { reflection: res.row, deleted: res.action === 'delete', success: true };
    },

    setDayNote: (_p: unknown, args: { input: { periodKey: string; body: string } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = upsertDayNote(owner, { period_key: i.periodKey, body: i.body });
      if (!res.ok) throw new GraphQLError('periodKey must be YYYY-MM-DD', { extensions: { code: 'BAD_USER_INPUT' } });
      broadcast(owner, res.action === 'delete' ? 'reflection:deleted' : 'reflection:updated', { kind: 'day_note', period_key: i.periodKey, position: 0 });
      return { reflection: res.row, deleted: res.action === 'delete', success: true };
    },

    toggleReflectionDone: (_p: unknown, args: { input: { kind: string; periodKey: string; position: number; done: boolean } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = toggleDone(owner, i.kind, i.position, { period_key: i.periodKey, done: i.done });
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
      const row = i.kind === 'today_goal' ? getTodayGoal(owner, i.periodKey) : getWeeklyGoals(owner, i.periodKey).find((r) => r.position === i.position);
      return { reflection: row ?? null, deleted: false, success: true };
    },

    deleteReflection: (_p: unknown, args: { input: { kind: string; periodKey: string; position: number } }) => {
      const owner = currentOwnerId();
      const i = args.input;
      const res = deleteGoal(owner, i.kind, i.position, i.periodKey);
      if (!res.ok) {
        throw new GraphQLError(res.error === 'bad_kind' ? 'invalid kind' : 'periodKey is required', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'reflection:deleted', { kind: i.kind, period_key: i.periodKey, position: i.position });
      return { reflection: null, deleted: true, success: true };
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
    category: (r: ReflectionRow) => {
      if (!r.category_id) return null;
      const row = getOwnedTag(currentOwnerId(), r.category_id);
      return row ? toNode(row) : null;
    },
    // kind, position, body map by name via the default resolver.
  },
};
