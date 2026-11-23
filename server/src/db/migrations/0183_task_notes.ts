import type { Database } from 'better-sqlite3';

export const id = '0183_task_notes';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE task_notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX ix_task_notes_task ON task_notes(owner_id, task_id, created_at, id);
  `);
}
