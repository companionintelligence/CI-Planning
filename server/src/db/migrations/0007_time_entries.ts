import type { Database } from 'better-sqlite3';

export const id = '0007_time_entries';

/**
 * time_entries — the persisted record of real work per task. The (at most one)
 * row WHERE ended_at IS NULL per owner IS the running-timer state; no separate
 * table is needed. A partial unique index makes "one active timer per owner" a
 * DB invariant, not just app logic. All timestamps are UTC ISO text.
 *
 * Block linkage is soft (ON DELETE SET NULL): deleting a block keeps the entry
 * and the task's actuals intact. Task linkage cascades.
 *
 * Idempotent: IF NOT EXISTS on the table and both indexes.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      owner_id   INTEGER NOT NULL REFERENCES owners(id),
      block_id   INTEGER REFERENCES time_blocks(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      source     TEXT DEFAULT 'timer',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // One running timer per owner: the single ended_at IS NULL row is unique.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_time_entries_one_running
           ON time_entries(owner_id) WHERE ended_at IS NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_time_entries_task ON time_entries(task_id)`);
}
