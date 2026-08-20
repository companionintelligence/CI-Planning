import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { dayTypeKeyExists } from './day-types.js';
import { writeAudit } from '../lib/audit.js';

export interface PatternRange { id: string; start_time: string; end_time: string }
export type DirectionWindows = Record<string, PatternRange[]>; // dirTagId → ranges

// 0156 — direction names the removed workday_start/workday_end fallback was
// replaced with. See docs/... (Auto's "fallback fill" / NL-hint outer bound):
// work+community is the general catch-all; home is added in only when the
// specific task/hint being placed is itself home-tagged.
export const FALLBACK_FILL_DIRECTION_NAMES = ['work', 'community'] as const;
export const HOME_DIRECTION_NAME = 'home';
export const WORK_DIRECTION_NAME = 'work';

export async function getPatternBlocks(ownerId: string, dayType: string): Promise<DirectionWindows> {
  const rows = await store()
    .prepare(
      `SELECT id, direction_tag_id, start_time, end_time
         FROM pattern_blocks
        WHERE owner_id = ? AND day_type = ?
        ORDER BY start_time`
    )
    .all(ownerId, dayType) as { id: string; direction_tag_id: string; start_time: string; end_time: string }[];
  const result: DirectionWindows = {};
  for (const r of rows) {
    if (!result[r.direction_tag_id]) result[r.direction_tag_id] = [];
    result[r.direction_tag_id].push({ id: r.id, start_time: r.start_time, end_time: r.end_time });
  }
  return result;
}

/**
 * Union of one or more direction tags' pattern_blocks windows for a day type,
 * resolved by tag NAME (not id) — the direction-name→id lookup autoplan.ts's
 * Pass 2a already does inline (`dirNameToId`), extracted here so every fallback
 * bound (0156: Pass 2b, fillByPriority, the single-task fallback, NL hint
 * bounds, patterns-place.ts, triality-vector.ts) shares one implementation.
 * Returns wall-clock ranges sorted earliest-first; callers convert to a
 * specific date's UTC ms themselves (zonedWallTimeToUTC), same as Pass 2a.
 * A direction name with no matching tag, or a tag with no configured windows,
 * contributes nothing — never throws, never falls back to a hardcoded default.
 */
export async function directionWindowsByName(
  ownerId: string,
  dayType: string,
  names: readonly string[],
): Promise<PatternRange[]> {
  if (names.length === 0) return [];
  const dirTags = await store()
    .prepare(
      `SELECT id FROM tags WHERE owner_id = ? AND kind = 'direction' AND name IN (${names.map(() => '?').join(',')})`,
    )
    .all(ownerId, ...names) as { id: string }[];
  if (dirTags.length === 0) return [];
  const patWindows = await getPatternBlocks(ownerId, dayType);
  return dirTags
    .flatMap((t) => patWindows[t.id] ?? [])
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
}

export async function setPatternBlockRanges(
  ownerId: string,
  dirTagId: string,
  dayType: string,
  ranges: { start_time: string; end_time: string }[]
): Promise<void> {
  await store().transaction(async () => {
    await store()
      .prepare(`DELETE FROM pattern_blocks WHERE owner_id = ? AND direction_tag_id = ? AND day_type = ?`)
      .run(ownerId, dirTagId, dayType);
    const ins = await store().prepare(
      `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of ranges) ins.run(newId(), ownerId, dirTagId, dayType, r.start_time, r.end_time);
  });
}

const TIME_RE = /^\d{2}:\d{2}$/;

export type ReplaceRangesResult =
  | { ok: true; ranges: PatternRange[] }
  | { ok: false; error: 'tag_not_found' | 'not_direction' | 'invalid_day_type' | 'bad_ranges'; message?: string };

/**
 * Validate + replace a direction's ranges for a day type (Phase W · W6b, Decision 3):
 * the owner-scoped tag/kind + day-type + HH:MM/order checks extracted from
 * routes/pattern-blocks.ts so REST + GraphQL share one implementation. Returns the
 * resulting ranges (the REST PUT's payload). writeAudit fires here; SSE is not emitted by
 * the REST route, so none is added.
 */
export async function replacePatternBlockRanges(
  ownerId: string,
  dirTagId: string,
  dayType: string,
  ranges: { start_time: string; end_time: string }[],
): Promise<ReplaceRangesResult> {
  const tag = await store().prepare(`SELECT kind FROM tags WHERE id = ? AND owner_id = ?`).get(dirTagId, ownerId) as { kind: string } | undefined;
  if (!tag) return { ok: false, error: 'tag_not_found' };
  if (tag.kind !== 'direction') return { ok: false, error: 'not_direction' };
  if (!await dayTypeKeyExists(ownerId, dayType)) return { ok: false, error: 'invalid_day_type' };
  if (!Array.isArray(ranges)) return { ok: false, error: 'bad_ranges', message: 'ranges must be an array' };
  for (const r of ranges) {
    if (!TIME_RE.test(String(r.start_time)) || !TIME_RE.test(String(r.end_time))) return { ok: false, error: 'bad_ranges', message: 'Times must be HH:MM' };
    if (String(r.start_time) >= String(r.end_time)) return { ok: false, error: 'bad_ranges', message: 'start_time must be before end_time' };
  }
  await setPatternBlockRanges(ownerId, dirTagId, dayType, ranges);
  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `pattern-block:${dirTagId}:${dayType}` });
  return { ok: true, ranges: (await getPatternBlocks(ownerId, dayType))[dirTagId] ?? [] };
}
