import type { Database } from 'better-sqlite3';

export const id = '0052_auto_scheduling';

/**
 * Auto-scheduling (Wave 3). One migration for the whole feature:
 *  1. scheduling_prefs.auto_mode — 'suggest' (stepped taps) | 'schedule' (zero-click
 *     on ingest). Default 'suggest' (the safe, non-silent posture).
 *  2. time_blocks.auto_run_id — stamps every block a placement run creates, so Undo
 *     can target the LAST run only (not the whole day, like clearPriorAuto).
 *  3. owners.last_auto_run_id — the most recent run per owner, for Undo's target.
 *
 * Additive + idempotent (each column-add is guarded). Forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'auto_mode')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN auto_mode TEXT NOT NULL DEFAULT 'suggest';`);
  }
  if (!hasColumn(db, 'time_blocks', 'auto_run_id')) {
    db.exec(`ALTER TABLE time_blocks ADD COLUMN auto_run_id TEXT;`);
  }
  if (!hasColumn(db, 'owners', 'last_auto_run_id')) {
    db.exec(`ALTER TABLE owners ADD COLUMN last_auto_run_id TEXT;`);
  }
}
