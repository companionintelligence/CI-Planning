import type { Database } from 'better-sqlite3';

export const id = '0178_day_window_overrides';

/** Per-date window edits override inherited day-type defaults for that date only. */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_window_overrides (
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      direction_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      ranges_json TEXT NOT NULL,
      PRIMARY KEY (owner_id, date, direction_tag_id)
    );
    CREATE INDEX IF NOT EXISTS ix_day_window_overrides_owner_date
      ON day_window_overrides(owner_id, date);
  `);
}
