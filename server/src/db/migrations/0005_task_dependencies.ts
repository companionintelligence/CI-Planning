import type { Database } from 'better-sqlite3';

export const id = '0005_task_dependencies';

/**
 * Dependency edges: task_id depends on depends_on_id. A task isn't scheduled
 * until every blocker is `done`. Self-edges are rejected by the CHECK; cycles
 * are rejected at write time (see engine/deps.ts). Edges hard-delete with either
 * endpoint via ON DELETE CASCADE.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (task_id, depends_on_id),
      CHECK (task_id <> depends_on_id)
    );
    CREATE INDEX IF NOT EXISTS idx_taskdeps_depends_on ON task_dependencies(depends_on_id);
  `);
}
