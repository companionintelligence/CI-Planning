import type { Database } from 'better-sqlite3';
import { serverTimezone } from '../lib/tz.js';

export function runSetup(db: Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
      planning_mode            TEXT DEFAULT 'ritual',
      timezone                 TEXT
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

  migrateColumns(db);
  seedDefaults(db);
}

/** Idempotent column migrations for existing databases. */
function migrateColumns(db: Database) {
  const addCol = (table: string, col: string, def: string) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  };
  addCol('tasks', 'notes', 'TEXT');
  addCol('tasks', 'task_time', 'TEXT');
  addCol('tasks', 'parent_id', 'INTEGER REFERENCES tasks(id) ON DELETE CASCADE');
  addCol('scheduling_prefs', 'timezone', 'TEXT');
  // Backfill a sensible default for rows predating the column so the scheduler
  // never has to guess a zone (workday hours are wall-clock in this zone).
  db.prepare(
    `UPDATE scheduling_prefs SET timezone = ? WHERE timezone IS NULL OR timezone = ''`
  ).run(serverTimezone());
}

function seedDefaults(db: Database) {
  const existing = db.prepare('SELECT id FROM owners WHERE id = 1').get();
  if (existing) return;

  db.prepare('INSERT INTO owners (id, name, email) VALUES (1, ?, ?)').run('Liam', 'liam.broza@gmail.com');
  db.prepare('INSERT INTO scheduling_prefs (owner_id, timezone) VALUES (1, ?)').run(serverTimezone());

  const jobs = [
    { name: 'ingest_gmail',       kind: 'ingest_gmail',       cron: '*/30 * * * *' },
    { name: 'ingest_gcal',        kind: 'ingest_gcal',        cron: '*/30 * * * *' },
    { name: 'promote_possibles',  kind: 'promote_possibles',  cron: '0 2 * * *' },
    { name: 'nightly_grooming',   kind: 'nightly_grooming',   cron: '0 2 * * *' },
    { name: 'auto_schedule',      kind: 'auto_schedule',      cron: '0 3 * * *' },
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO scheduled_jobs (name, kind, cron) VALUES (?, ?, ?)');
  for (const j of jobs) insert.run(j.name, j.kind, j.cron);
}
