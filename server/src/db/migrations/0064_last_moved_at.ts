import type { Database } from 'better-sqlite3';

export const id = '0064_last_moved_at';

/** B1 — stamp the UTC instant a block was moved by reflow, for the anti-thrash stability window. */
export function up(db: Database): void {
  db.exec(`ALTER TABLE time_blocks ADD COLUMN last_moved_at TEXT`);
}
