import type { Database } from 'better-sqlite3';

export const id = '0081_objectives';

/**
 * Phase N1 — Objective hierarchy + flight_plan source rework.
 *
 * 1. `objectives` — self-nesting entity (goal → project → milestone via depth).
 *    `level` is server-derived from depth; `progress_cache` is NULL when empty
 *    (load-bearing rot signal, not the same as 0%).
 * 2. `objective_tasks` — M:N between objectives and tasks. A task may serve
 *    multiple objectives; rollup uses all of them.
 * 3. `flight_plan` source rework — collapse `source_pattern_id` + (new)
 *    `source_objective_id` into one `(source_kind, source_ref)` pair so the
 *    objective nominator can UPSERT to repoint an already-staged row.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS objectives (
      id           TEXT NOT NULL PRIMARY KEY,
      owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      parent_id    TEXT REFERENCES objectives(id) ON DELETE SET NULL,
      level        TEXT NOT NULL DEFAULT 'goal',
      horizon      TEXT NOT NULL DEFAULT 'none',
      title        TEXT NOT NULL,
      description  TEXT,
      target_date  TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      category_id  TEXT REFERENCES tags(id) ON DELETE SET NULL,
      progress_cache REAL,
      cadence      TEXT NOT NULL DEFAULT 'none',
      last_advanced_at TEXT,
      priority     INTEGER DEFAULT 3,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_objectives_owner ON objectives(owner_id);
    CREATE INDEX IF NOT EXISTS ix_objectives_parent ON objectives(owner_id, parent_id);

    CREATE TABLE IF NOT EXISTS objective_tasks (
      objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
      task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (objective_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS ix_objective_tasks_task ON objective_tasks(task_id);

    ALTER TABLE flight_plan ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE flight_plan ADD COLUMN source_ref  TEXT;
  `);

  // Backfill: rows that had a source_pattern_id get source_kind='pattern'.
  db.prepare(
    `UPDATE flight_plan
        SET source_kind = 'pattern',
            source_ref  = source_pattern_id
      WHERE source_pattern_id IS NOT NULL`
  ).run();

  // Drop the legacy column (SQLite 3.35+; no index on this column, so DROP COLUMN is safe).
  db.exec(`ALTER TABLE flight_plan DROP COLUMN source_pattern_id;`);
}
