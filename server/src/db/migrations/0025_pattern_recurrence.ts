import type { Database } from 'better-sqlite3';

export const id = '0025_pattern_recurrence';

/**
 * Pattern-level recurrence + the nightly auto-place job (PR-C+, Phase D).
 *
 * A Habit or Routine pattern can now carry an RRULE (`recurrence_rule`) +
 * its anchor (`recurrence_dtstart`, UTC ISO at local-noon to dodge DST). At
 * 06:00 local, the `place_patterns` cron expands every owner's patterns whose
 * rule fires today and calls `placePatternOnDay` for each — idempotently, via
 * the marker on `time_blocks` (source_kind='pattern', source_ref=patternId).
 * Ritual patterns are excluded (they're hidden behind a flag in V1).
 *
 * Schema decision: NO `last_placed_date` column. Idempotency rides on a
 * partial covering index over `time_blocks(source_ref, start_at) WHERE
 * source_kind='pattern'`, so deleting placed blocks self-heals the marker.
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

  db.exec(`INSERT OR IGNORE INTO scheduled_jobs (name, kind, cron)
           VALUES ('place_patterns', 'place_patterns', '0 6 * * *')`);
}
