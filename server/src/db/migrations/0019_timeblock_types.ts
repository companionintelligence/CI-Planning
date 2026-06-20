import type { Database } from 'better-sqlite3';

export const id = '0019_timeblock_types';

/**
 * Plan vs Concept Time-Blocks (Step 2b). A `block_kind = 'timeblock'` container is
 * now one of two types:
 *  - **Plan** — scheduled (uses start_at/end_at on the timed grid).
 *  - **Concept** — an unscheduled goal: a `goal_start_date` (nullable; null = "someday")
 *    + `duration_minutes`, with no fixed time. Since start_at/end_at are NOT NULL,
 *    a concept stores a placeholder time (goal-day midnight) and `all_day = 1`; the
 *    client renders it off the minute grid (horizon lane + a goal-day header chip),
 *    keying off `goal_start_date`/`duration_minutes`, never the placeholder.
 *
 * Additive + idempotent. Existing containers are backfilled to 'plan'.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, sql: string) => { if (!cols.includes(name)) db.exec(sql); };

  add('block_type', `ALTER TABLE time_blocks ADD COLUMN block_type TEXT`);          // 'plan' | 'concept'
  add('goal_start_date', `ALTER TABLE time_blocks ADD COLUMN goal_start_date TEXT`); // YYYY-MM-DD (concepts)
  add('duration_minutes', `ALTER TABLE time_blocks ADD COLUMN duration_minutes INTEGER`); // concepts

  // Containers created before the split (Step 1 drawer) are Plans.
  db.exec(`UPDATE time_blocks SET block_type = 'plan' WHERE block_kind = 'timeblock' AND block_type IS NULL`);
}
