import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { getOwnedTag } from '../services/tags.js';
import {
  listDayTypes, getDayType, resolveDayTypeWithSource,
  createDayTypeChecked, renameDayTypeChecked, deleteDayTypeChecked,
  type DayType,
} from '../services/day-types.js';
import { getCategoryPrefs, setCategoryPrefChecked, type CategoryPref } from '../services/category-prefs.js';
import { toNode } from './tag-resolvers.js';

/**
 * DayTypeType + TagPrefType resolvers (Phase W · W7). Reuse services/day-types.ts +
 * category-prefs.ts (Decision 3) — the SAME owner-scoped functions (incl. the extracted
 * validation wrappers) the REST routes call. Owner comes from `currentOwnerId()`, never
 * the client; the non-null `TagPrefType.category` re-fetches the tag owner-scoped and
 * throws if it can't load. These REST routes emit no SSE, so neither do the mutations.
 */

/** A real 'YYYY-MM-DD' calendar date (mirrors routes/day-types.ts isISODate). */
function isISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The GraphQL node shape a TagPrefType resolver reads (the category pref + its tag id). */
type TagPrefNode = CategoryPref & { tag_id: string };

export const dayTypeResolvers = {
  Query: {
    dayTypes: async () => await listDayTypes(currentOwnerId()),
    dayType: async (_p: unknown, args: { id: string }) => await getDayType(currentOwnerId(), args.id) ?? null,
    resolveDayType: async (_p: unknown, args: { date: string }) => {
      if (!isISODate(args.date)) throw new GraphQLError('date must be YYYY-MM-DD', { extensions: { code: 'BAD_USER_INPUT' } });
      // Parenthesised: spreading a PENDING promise yields `{}` — no own enumerable
      // properties — so `key` and `source` would silently vanish from the payload.
      return { date: args.date, ...(await resolveDayTypeWithSource(currentOwnerId(), args.date)) };
    },
    tagPrefs: async (): Promise<TagPrefNode[]> =>
      Object.entries(await getCategoryPrefs(currentOwnerId())).map(([tagId, pref]) => ({ ...pref, tag_id: tagId })),
  },

  Mutation: {
    createDayType: async (_p: unknown, args: { input: { key: string; name: string } }) => {
      const res = await createDayTypeChecked(currentOwnerId(), args.input.key, args.input.name);
      if (!res.ok) {
        if (res.error === 'bad_key') throw new GraphQLError('key must be a lowercase slug', { extensions: { code: 'BAD_USER_INPUT' } });
        if (res.error === 'name_required') throw new GraphQLError('name is required', { extensions: { code: 'BAD_USER_INPUT' } });
        throw new GraphQLError('A day type with that key already exists', { extensions: { code: 'CONFLICT' } });
      }
      return { dayType: res.dayType, success: true };
    },

    renameDayType: async (_p: unknown, args: { input: { id: string; name: string } }) => {
      const res = await renameDayTypeChecked(currentOwnerId(), args.input.id, args.input.name);
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('Day type not found', { extensions: { code: 'NOT_FOUND' } });
        throw new GraphQLError('name is required', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      return { dayType: res.dayType, success: true };
    },

    deleteDayType: async (_p: unknown, args: { input: { id: string } }) => {
      const res = await deleteDayTypeChecked(currentOwnerId(), args.input.id);
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('Day type not found', { extensions: { code: 'NOT_FOUND' } });
        throw new GraphQLError('Built-in day types cannot be deleted', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      return { deletedId: args.input.id, success: true };
    },

    setTagPref: async (_p: unknown, args: { input: { categoryTagId: string; colorToken?: string | null; defaultMinutes?: number | null } }) => {
      const i = args.input;
      const patch: Record<string, unknown> = {};
      if (i.colorToken != null) patch.color_token = i.colorToken;
      if (i.defaultMinutes != null) patch.default_minutes = i.defaultMinutes;
      const res = await setCategoryPrefChecked(currentOwnerId(), i.categoryTagId, patch);
      if (!res.ok) {
        if (res.error === 'tag_not_found') throw new GraphQLError('Tag not found', { extensions: { code: 'NOT_FOUND' } });
        const msg =
          res.error === 'not_category' ? 'Tag is not a category'
            : res.error === 'color_token_invalid' ? 'colorToken must be a non-empty string'
              : 'defaultMinutes must be a positive integer';
        throw new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      return { tagPref: { ...res.pref, tag_id: i.categoryTagId }, success: true };
    },
  },

  DayTypeType: {
    isBuiltin: (d: DayType) => d.is_builtin,
    // id, key, name map by name via the default resolver.
  },

  TagPrefType: {
    id: (p: TagPrefNode) => p.tag_id,
    colorToken: (p: TagPrefNode) => p.color_token,
    defaultMinutes: (p: TagPrefNode) => p.default_minutes,
    // Non-null (TagType!): the category tag exists + is owner-scoped; throw rather than
    // null the non-null field if it somehow can't load.
    category: async (p: TagPrefNode) => {
      const row = await getOwnedTag(currentOwnerId(), p.tag_id);
      if (!row) throw new GraphQLError('category tag not found', { extensions: { code: 'NOT_FOUND' } });
      return toNode(row);
    },
  },
};
