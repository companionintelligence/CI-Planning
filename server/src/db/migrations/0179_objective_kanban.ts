import type { Database } from 'better-sqlite3';

export const id = '0179_objective_kanban';

/** Persist owner-defined objective board columns and each task's board placement. */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS objective_board_columns (
      id TEXT NOT NULL PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      system_key TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(owner_id, system_key)
    );
    CREATE INDEX IF NOT EXISTS ix_objective_board_columns_owner
      ON objective_board_columns(owner_id, position);

    CREATE TABLE IF NOT EXISTS objective_board_cards (
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      column_id TEXT NOT NULL REFERENCES objective_board_columns(id) ON DELETE CASCADE,
      position REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS ix_objective_board_cards_column
      ON objective_board_cards(owner_id, column_id, position);
  `);
}
