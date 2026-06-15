import type { Database } from 'better-sqlite3';

export const id = '0006_actual_minutes';

/**
 * Measured actuals: every task carries an estimate AND a real total. The value
 * is the SUM of finished time_entries (recomputed on each stop), so it stays
 * exact across many sessions, restarts, and entry deletion (FK cascade).
 *
 * Idempotent via the B0 addColumn-if-missing pattern.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has('actual_minutes')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN actual_minutes INTEGER NOT NULL DEFAULT 0`);
  }
}
