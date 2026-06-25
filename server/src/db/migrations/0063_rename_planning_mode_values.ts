import type { Database } from 'better-sqlite3';

export const id = '0063_rename_planning_mode_values';

/** Rename planning_mode values: 'ritual' → 'basic', 'auto' → 'smart'. */
export function up(db: Database): void {
  // Guard: databases that pre-date the planning_mode column (0.2-era) have it added
  // by later ALTER migrations; skip the rename if the column isn't there yet.
  const has = (db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('scheduling_prefs') WHERE name = 'planning_mode'`).get() as { c: number }).c > 0;
  if (!has) return;
  db.exec(`
    UPDATE scheduling_prefs SET planning_mode = 'basic' WHERE planning_mode = 'ritual';
    UPDATE scheduling_prefs SET planning_mode = 'smart' WHERE planning_mode = 'auto';
  `);
}
