import type { Database } from 'better-sqlite3';

export const id = '0055_fill_order';

/**
 * Adds scheduling_prefs.fill_order — controls how Auto Schedule orders leftover
 * tasks when filling workday capacity after tag-matched placement.
 *   'priority' (default) → highest priority first (P1 first), same as the old tap-3.
 *   'overdue'            → most overdue first, ordered by due_at ascending.
 *
 * Additive + idempotent. Forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'fill_order')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN fill_order TEXT NOT NULL DEFAULT 'priority';`);
  }
}
