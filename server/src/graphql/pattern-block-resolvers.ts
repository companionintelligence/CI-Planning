import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { getOwnedTag } from '../services/tags.js';
import { getPatternBlocks, replacePatternBlockRanges } from '../services/pattern-blocks.js';
import { getPatternPrefs, setPatternPrefChecked, type PatternPref } from '../services/pattern-prefs.js';
import { toNode } from './tag-resolvers.js';

/**
 * PatternBlockType + PatternPrefType resolvers (Phase W · W6b). Reuse
 * services/pattern-blocks.ts + pattern-prefs.ts (Decision 3) — the SAME owner-scoped
 * functions the REST routes call (including the extracted validation wrappers). Owner
 * comes from `currentOwnerId()`, never the client; the non-null `direction` field
 * re-fetches the tag owner-scoped and THROWS if it can't be loaded (rather than nulling a
 * non-null field), and the mutations' service checks reject a foreign/non-direction tag.
 * The REST routes emit no SSE for these, so neither do the mutations.
 */

/** The flat GraphQL row shape a PatternBlockType resolver reads. */
interface BlockRow { id: string; direction_tag_id: string; day_type: string; start_time: string; end_time: string }
/** The GraphQL node shape a PatternPrefType resolver reads (the pref + its direction tag id). */
type PrefNode = PatternPref & { tag_id: string };

export const patternBlockResolvers = {
  Query: {
    patternBlocks: async (_p: unknown, args: { dayType: string }): Promise<BlockRow[]> => {
      const windows = await getPatternBlocks(currentOwnerId(), args.dayType);
      const rows = Object.entries(windows).flatMap(([dirId, ranges]) =>
        ranges.map((r) => ({ id: r.id, direction_tag_id: dirId, day_type: args.dayType, start_time: r.start_time, end_time: r.end_time })),
      );
      // Deterministic (direction, start) order — Object.entries key order follows the
      // per-direction SQL row order, not a stable cross-direction sort, so sort explicitly.
      return rows.sort((a, b) => a.direction_tag_id.localeCompare(b.direction_tag_id) || a.start_time.localeCompare(b.start_time));
    },
    patternPrefs: async (): Promise<PrefNode[]> =>
      Object.entries(await getPatternPrefs(currentOwnerId())).map(([tagId, pref]) => ({ ...pref, tag_id: tagId })),
  },

  Mutation: {
    setPatternBlockRanges: async (
      _p: unknown,
      args: { input: { directionTagId: string; dayType: string; ranges: { startTime: string; endTime: string }[] } },
    ) => {
      const owner = currentOwnerId();
      const ranges = args.input.ranges.map((r) => ({ start_time: r.startTime, end_time: r.endTime }));
      const res = await replacePatternBlockRanges(owner, args.input.directionTagId, args.input.dayType, ranges);
      if (!res.ok) {
        if (res.error === 'tag_not_found') throw new GraphQLError('Tag not found', { extensions: { code: 'NOT_FOUND' } });
        const msg =
          res.error === 'not_direction' ? 'Tag is not a direction'
            : res.error === 'invalid_day_type' ? 'Invalid day_type'
              : (res.message ?? 'invalid ranges');
        throw new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const blocks: BlockRow[] = res.ranges.map((r) => ({
        id: r.id, direction_tag_id: args.input.directionTagId, day_type: args.input.dayType, start_time: r.start_time, end_time: r.end_time,
      }));
      return { patternBlocks: blocks, success: true };
    },

    setPatternPref: async (
      _p: unknown,
      args: { input: { directionTagId: string; autoFill?: boolean | null; reminderOffsets?: number[] | null; iconShape?: string | null; colorToken?: string | null; defaultMinutes?: number | null } },
    ) => {
      const owner = currentOwnerId();
      const i = args.input;
      // Only forward keys the client sent (absent = merge-preserve in setPatternPref).
      const patch: Record<string, unknown> = {};
      if (i.autoFill != null) patch.auto_fill = i.autoFill;
      if (i.reminderOffsets != null) patch.reminder_offsets = i.reminderOffsets;
      if (i.iconShape != null) patch.icon_shape = i.iconShape;
      if (i.colorToken != null) patch.color_token = i.colorToken;
      if (i.defaultMinutes != null) patch.default_minutes = i.defaultMinutes;
      const res = await setPatternPrefChecked(owner, i.directionTagId, patch);
      if (!res.ok) {
        if (res.error === 'tag_not_found') throw new GraphQLError('Tag not found', { extensions: { code: 'NOT_FOUND' } });
        const msg =
          res.error === 'not_direction' ? 'Tag is not a direction'
            : res.error === 'reminder_offsets_invalid' ? 'reminderOffsets must be an array of non-negative integers'
              : res.error === 'icon_shape_invalid' ? 'iconShape must be circle, square, or triangle'
                : res.error === 'color_token_invalid' ? 'colorToken must be a non-empty string'
                  : res.error === 'default_minutes_invalid' ? 'defaultMinutes must be a positive integer'
                    : 'autoFill must be a boolean';
        throw new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      return { patternPref: { ...res.pref, tag_id: i.directionTagId }, success: true };
    },
  },

  PatternBlockType: {
    dayType: (b: BlockRow) => b.day_type,
    startTime: (b: BlockRow) => b.start_time,
    endTime: (b: BlockRow) => b.end_time,
    // Non-null (TagType!): the direction FK + owner-scoping guarantee it resolves; throw
    // rather than return null into the non-null field if it somehow can't.
    direction: (b: BlockRow) => {
      const row = getOwnedTag(currentOwnerId(), b.direction_tag_id);
      if (!row) throw new GraphQLError('direction tag not found', { extensions: { code: 'NOT_FOUND' } });
      return toNode(row);
    },
    // id maps by name via the default resolver.
  },

  PatternPrefType: {
    id: (p: PrefNode) => p.tag_id,
    autoFill: (p: PrefNode) => p.auto_fill,
    reminderOffsets: (p: PrefNode) => p.reminder_offsets,
    iconShape: (p: PrefNode) => p.icon_shape,
    colorToken: (p: PrefNode) => p.color_token,
    defaultMinutes: (p: PrefNode) => p.default_minutes,
    direction: (p: PrefNode) => {
      const row = getOwnedTag(currentOwnerId(), p.tag_id);
      if (!row) throw new GraphQLError('direction tag not found', { extensions: { code: 'NOT_FOUND' } });
      return toNode(row);
    },
  },
};
