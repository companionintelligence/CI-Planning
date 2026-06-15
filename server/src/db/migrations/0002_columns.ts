import type { Database } from 'better-sqlite3';

export const id = '0002_columns';

/**
 * Column additions that accreted over time, as idempotent add-if-missing ALTERs.
 * On a fresh DB the baseline already has these columns, so each is a no-op
 * (caught). On an existing 0.2 DB they bring the tables up to the current shape.
 * This is the historical `migrateColumns()` set, now version-tracked.
 */
export function up(db: Database): void {
  const addCol = (table: string, col: string, def: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch {
      /* column already exists — idempotent */
    }
  };

  addCol('tasks', 'notes', 'TEXT');
  addCol('tasks', 'task_time', 'TEXT');
  addCol('tasks', 'parent_id', 'INTEGER REFERENCES tasks(id) ON DELETE CASCADE');
  addCol('scheduling_prefs', 'timezone', 'TEXT');
  addCol('scheduling_prefs', 'planning_horizon_days', 'INTEGER DEFAULT 7');
  addCol('daily_summaries', 'focus', "TEXT NOT NULL DEFAULT '[]'");
}
