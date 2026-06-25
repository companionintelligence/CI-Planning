import type { Database } from 'better-sqlite3';

export const id = '0001_baseline';

/**
 * The full current schema, emitted with IF NOT EXISTS so it's a no-op on an
 * existing 0.2 database (which already has these tables) and a clean create on a
 * fresh one. Column-level additions made over time live in 0002_columns.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owners (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL,
      email TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      title              TEXT NOT NULL,
      description        TEXT,
      notes              TEXT,
      due_at             TEXT,
      task_time          TEXT,
      estimated_minutes  INTEGER,
      priority           INTEGER DEFAULT 3,
      status             TEXT DEFAULT 'open',
      parent_id          INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      owner_id           INTEGER REFERENCES owners(id),
      source_kind        TEXT DEFAULT 'manual',
      source_ref         TEXT,
      created_at         TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS possible_tasks (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_title           TEXT NOT NULL,
      raw_summary         TEXT,
      proposed_due_at     TEXT,
      proposed_priority   INTEGER,
      proposed_owner_id   INTEGER REFERENCES owners(id),
      source_kind         TEXT,
      source_ref          TEXT,
      source_payload      TEXT,
      confidence          REAL,
      status              TEXT DEFAULT 'pending',
      promoted_task_id    INTEGER REFERENCES tasks(id),
      created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_kind, source_ref)
    );

    CREATE TABLE IF NOT EXISTS time_blocks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      block_kind  TEXT DEFAULT 'task',
      start_at    TEXT NOT NULL,
      end_at      TEXT NOT NULL,
      is_locked   INTEGER DEFAULT 0,
      is_auto     INTEGER DEFAULT 1,
      source_kind TEXT DEFAULT 'manual',
      source_ref  TEXT,
      status      TEXT DEFAULT 'planned',
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scheduling_prefs (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id                 INTEGER REFERENCES owners(id),
      workday_start            TEXT DEFAULT '09:00',
      workday_end              TEXT DEFAULT '18:00',
      deep_work_windows        TEXT,
      max_focus_block_minutes  INTEGER DEFAULT 90,
      min_break_minutes        INTEGER DEFAULT 10,
      day_theme                TEXT,
      planning_mode            TEXT DEFAULT 'basic',
      timezone                 TEXT,
      planning_horizon_days    INTEGER DEFAULT 7
    );

    CREATE TABLE IF NOT EXISTS daily_summaries (
      owner_id    INTEGER NOT NULL DEFAULT 1 REFERENCES owners(id),
      date        TEXT NOT NULL,
      prose       TEXT NOT NULL,
      stats       TEXT NOT NULL,
      focus       TEXT NOT NULL DEFAULT '[]',
      llm         INTEGER NOT NULL DEFAULT 0,
      inputs_hash TEXT NOT NULL,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_id, date)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS task_tags (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS possible_task_tags (
      possible_task_id INTEGER NOT NULL REFERENCES possible_tasks(id) ON DELETE CASCADE,
      tag_id           INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (possible_task_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      kind        TEXT NOT NULL,
      cron        TEXT NOT NULL,
      enabled     INTEGER DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      config      TEXT
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id        INTEGER REFERENCES scheduled_jobs(id),
      started_at    TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at   TEXT,
      status        TEXT DEFAULT 'running',
      items_created INTEGER DEFAULT 0,
      items_updated INTEGER DEFAULT 0,
      log           TEXT
    );
  `);
}
