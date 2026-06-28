import type { Database } from 'better-sqlite3';

export const id = '0072_default_time_block_minutes';

/**
 * Adds `default_time_block_minutes` to scheduling_prefs — the suggested block
 * duration when the user creates a new time block without a category default.
 * Exposed in Settings → Time-Block Settings → Scheduled Block.
 */
export function up(db: Database): void {
  db.exec(`
    ALTER TABLE scheduling_prefs ADD COLUMN default_time_block_minutes INTEGER DEFAULT 60;
  `);
}
