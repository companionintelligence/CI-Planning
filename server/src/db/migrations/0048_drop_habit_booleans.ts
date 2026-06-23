import type { Database } from 'better-sqlite3';

export const id = '0048_drop_habit_booleans';

/**
 * W1-A PR2 contract step: remove the `is_habit` / `is_fast_task` boolean aliases
 * now that every engine read and API serialisation path uses `subtype` (W1-A PR1).
 * `taskToApi()` in lib/serialize.ts continues to derive these fields for any clients
 * still reading them in the payload.
 */
export function up(db: Database): void {
  db.exec(`
    ALTER TABLE tasks DROP COLUMN is_habit;
    ALTER TABLE tasks DROP COLUMN is_fast_task;
  `);
}
