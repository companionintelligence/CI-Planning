import type { Database } from 'better-sqlite3';

export const id = '0025_pattern_recurrence';

/**
 * Pattern-level recurrence (PR-C+, Phase D).
 *
 * A Habit or Routine pattern can now carry an RRULE (`recurrence_rule`) + its
 * anchor (`recurrence_dtstart`, UTC ISO at local-noon to dodge DST). Placement
 * is **lazy on read**: `GET /api/blocks` calls `ensurePatternsForRange` to make
 * sure every recurring pattern firing inside the window is on the board before
 * the SELECT, idempotently via the marker on `time_blocks` (source_kind=
 * 'pattern', source_ref=patternId). Ritual patterns are excluded in V1.
 *
 * Schema decision: NO `last_placed_date` column. Idempotency rides on a
 * partial covering index over `time_blocks(source_ref, start_at) WHERE
 * source_kind='pattern'`, so deleting placed blocks self-heals the marker.
 *
 * Note: an earlier draft seeded a `place_patterns` cron here; it was dropped
 * before merge in favour of lazy on-read placement. Migration 0026 cleans up
 * any seeded row that may already exist in older dev DBs.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(patterns)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('recurrence_rule')) db.exec(`ALTER TABLE patterns ADD COLUMN recurrence_rule TEXT`);
  if (!cols.includes('recurrence_dtstart')) db.exec(`ALTER TABLE patterns ADD COLUMN recurrence_dtstart TEXT`);

  db.exec(`CREATE INDEX IF NOT EXISTS ix_time_blocks_pattern_source
             ON time_blocks(source_ref, start_at)
             WHERE source_kind = 'pattern'`);
}
