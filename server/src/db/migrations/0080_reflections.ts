import type { Database } from 'better-sqlite3';

export const id = '0080_reflections';

/**
 * Phase N0 — `reflections` support table.
 *
 * Stores daily and weekly goals (N0) and will absorb morning/weekly-review prose
 * in N3. Pure composite PK — no `id` column — matching the `daily_plan` precedent;
 * a row is fully addressed by (owner, kind, period_key, position).
 *
 * kind:       'today_goal' | 'weekly_goal'  (N3 adds 'morning' | 'weekly')
 * period_key: 'YYYY-MM-DD' for today goals, 'YYYY-Www' for weekly goals
 * position:   0 for today (only one slot); 0–2 for weekly (three stable slots)
 *
 * Rollover is key-only — no cron. A new day/week returns no rows; prior rows
 * persist and become the snapshot the N3 weekly review reads.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      owner_id    TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL,
      period_key  TEXT    NOT NULL,
      position    INTEGER NOT NULL DEFAULT 0,
      body        TEXT    NOT NULL DEFAULT '',
      category_id TEXT    REFERENCES tags(id) ON DELETE SET NULL,
      done_at     TEXT,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL,
      PRIMARY KEY (owner_id, kind, period_key, position)
    );
    CREATE INDEX IF NOT EXISTS ix_reflections_owner_kind_period
      ON reflections(owner_id, kind, period_key);
  `);
}
