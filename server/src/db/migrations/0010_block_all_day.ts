import type { Database } from 'better-sqlite3';

export const id = '0010_block_all_day';

/**
 * Phase F PR-3: all-day events.
 *
 * Add a boolean `all_day` column to `time_blocks` (default 0/false). All-day
 * blocks render in a pinned header lane, excluded from the minute axis. The add
 * is idempotent — a re-run, or a DB where the baseline already grew the column,
 * is a no-op. A client built against `all_day` talking to a pre-migration server
 * degrades gracefully (treats a missing value as false), so shipping the column
 * before the client reads it is safe but not strictly required.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[];
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has('all_day')) {
    db.exec(`ALTER TABLE time_blocks ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0`);
  }
}
