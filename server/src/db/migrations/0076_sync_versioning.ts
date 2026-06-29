import type { Database } from 'better-sqlite3';

export const id = '0076_sync_versioning';

/**
 * Adds `version`, `updated_at`, and `field_ts` to `tasks` and `time_blocks`
 * for Phase L field-level merge and SSE catch-up. `version` advances
 * monotonically on every applied op; `field_ts` is a JSON map of
 * { field: utcIso } for per-field LWW; `updated_at` is the server clock
 * of the last applied change.
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
 */
export function up(db: Database): void {
  const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  if (!taskCols.includes('version'))    db.exec(`ALTER TABLE tasks ADD COLUMN version    INTEGER NOT NULL DEFAULT 1`);
  if (!taskCols.includes('updated_at')) db.exec(`ALTER TABLE tasks ADD COLUMN updated_at TEXT`);
  if (!taskCols.includes('field_ts'))   db.exec(`ALTER TABLE tasks ADD COLUMN field_ts   TEXT`);

  const blockCols = (db.prepare('PRAGMA table_info(time_blocks)').all() as { name: string }[]).map((c) => c.name);
  if (!blockCols.includes('version'))    db.exec(`ALTER TABLE time_blocks ADD COLUMN version    INTEGER NOT NULL DEFAULT 1`);
  if (!blockCols.includes('updated_at')) db.exec(`ALTER TABLE time_blocks ADD COLUMN updated_at TEXT`);
  if (!blockCols.includes('field_ts'))   db.exec(`ALTER TABLE time_blocks ADD COLUMN field_ts   TEXT`);
}
