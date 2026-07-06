import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { dayTypeKeyExists } from './day-types.js';
import { writeAudit } from '../lib/audit.js';

export interface PatternRange { id: string; start_time: string; end_time: string }
export type DirectionWindows = Record<string, PatternRange[]>; // dirTagId → ranges

export function getPatternBlocks(ownerId: string, dayType: string): DirectionWindows {
  const rows = sqlite
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

export function setPatternBlockRanges(
  ownerId: string,
  dirTagId: string,
  dayType: string,
  ranges: { start_time: string; end_time: string }[]
): void {
  sqlite.transaction(() => {
    sqlite
      .prepare(`DELETE FROM pattern_blocks WHERE owner_id = ? AND direction_tag_id = ? AND day_type = ?`)
      .run(ownerId, dirTagId, dayType);
    const ins = sqlite.prepare(
      `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of ranges) ins.run(newId(), ownerId, dirTagId, dayType, r.start_time, r.end_time);
  })();
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
export function replacePatternBlockRanges(
  ownerId: string,
  dirTagId: string,
  dayType: string,
  ranges: { start_time: string; end_time: string }[],
): ReplaceRangesResult {
  const tag = sqlite.prepare(`SELECT kind FROM tags WHERE id = ? AND owner_id = ?`).get(dirTagId, ownerId) as { kind: string } | undefined;
  if (!tag) return { ok: false, error: 'tag_not_found' };
  if (tag.kind !== 'direction') return { ok: false, error: 'not_direction' };
  if (!dayTypeKeyExists(ownerId, dayType)) return { ok: false, error: 'invalid_day_type' };
  if (!Array.isArray(ranges)) return { ok: false, error: 'bad_ranges', message: 'ranges must be an array' };
  for (const r of ranges) {
    if (!TIME_RE.test(String(r.start_time)) || !TIME_RE.test(String(r.end_time))) return { ok: false, error: 'bad_ranges', message: 'Times must be HH:MM' };
    if (String(r.start_time) >= String(r.end_time)) return { ok: false, error: 'bad_ranges', message: 'start_time must be before end_time' };
  }
  setPatternBlockRanges(ownerId, dirTagId, dayType, ranges);
  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `pattern-block:${dirTagId}:${dayType}` });
  return { ok: true, ranges: getPatternBlocks(ownerId, dayType)[dirTagId] ?? [] };
}
