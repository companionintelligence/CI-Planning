import type { Database } from 'better-sqlite3';

export const id = '0177_objective_task_approval';

/** Track objective quick-add drafts until a person explicitly approves them. */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'tasks', 'auto_generated')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!hasColumn(db, 'tasks', 'human_approved_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN human_approved_at TEXT;`);
  }
}
