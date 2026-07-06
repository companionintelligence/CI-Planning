import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { isValidISODate } from '../lib/dates.js';
import {
  listDayStars, getDailyRecap, type DayStarsRow, type DailyRecapRow,
} from '../services/stars.js';

/**
 * DayStarsType + DailyRecapType resolvers (Phase W · W8c). Reuse services/stars.ts
 * (Decision 3) — the SAME owner-scoped reads GET /api/stars uses. Owner comes from
 * `currentOwnerId()`, never the client; every read filters owner_id. Read-only surface
 * (no star/recap writes exist in REST), so no Mutation entries.
 *
 * `id` for both types is the 'YYYY-MM-DD' date (natural-key-as-Node-id, per owner —
 * the convention FlightPlanEntry/TagPref already use). The JSON `stats`/`focus` columns
 * are stored as JSON-TEXT on disk; the field resolvers parse them so the JSON scalar
 * serializes a real object, not a doubly-encoded string.
 */

function requireISODate(value: string, argName: string): string {
  if (!isValidISODate(value)) {
    throw new GraphQLError(`${argName} must be YYYY-MM-DD`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return value;
}

/** Parse a JSON-TEXT column into a JS value; null stays null, bad JSON becomes null. */
function parseJson(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const starsResolvers = {
  Query: {
    dayStars: (_p: unknown, args: { from: string; to: string }): DayStarsRow[] =>
      listDayStars(currentOwnerId(), requireISODate(args.from, 'from'), requireISODate(args.to, 'to')),
    dailyRecap: (_p: unknown, args: { date: string }): DailyRecapRow | null =>
      getDailyRecap(currentOwnerId(), requireISODate(args.date, 'date')),
  },

  DayStarsType: {
    id: (r: DayStarsRow) => r.date,
    // date/objective/habits/tasks/bonus/note/total/frozen map by name.
  },

  DailyRecapType: {
    id: (r: DailyRecapRow) => r.date,
    stats: (r: DailyRecapRow) => parseJson(r.stats),
    focus: (r: DailyRecapRow) => parseJson(r.focus),
    // date/prose/llm/inputsHash/objective/habits/tasks/bonus/note/total/frozenAt map by name.
  },
};
