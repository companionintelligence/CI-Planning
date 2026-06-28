import type { Database } from 'better-sqlite3';

export const id = '0074_pattern_day_optouts';

/**
 * Per-(owner, pattern, local-day) opt-out for recurring pattern placement.
 *
 * Recurring Habit/Routine patterns auto-place lazily on every GET /api/blocks
 * read (`ensurePatternsForRange`), idempotent via a marker on the placed blocks.
 * The flaw: deleting a placed container leaves no marker, so the very next read
 * (the refetch the client fires right after the delete) re-places it — the block
 * could never be removed. This table records "the user removed pattern P on local
 * day D"; `placePatternOnDay` honours it on the free/auto path, so the deletion
 * sticks. An explicit re-placement (manual "place into a Plan", blockId given)
 * overrides it. ON DELETE CASCADE drops opt-outs when the pattern itself is gone.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_day_optouts (
      owner_id   TEXT NOT NULL REFERENCES owners(id),
      pattern_id TEXT NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
      date       TEXT NOT NULL,
      PRIMARY KEY (owner_id, pattern_id, date)
    );
  `);
}
