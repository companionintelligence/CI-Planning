import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';

export interface PatternRange { id: string; start_time: string; end_time: string }
export type DirectionWindows = Record<string, PatternRange[]>; // dirTagId → ranges

export function getPatternBlocks(ownerId: string, dayType: 'workday' | 'weekend'): DirectionWindows {
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
