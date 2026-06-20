import type { Database } from 'better-sqlite3';

export const id = '0020_fast_tasks';

/**
 * Fast tasks (Step 3). A **fast task** is a lightweight, ritual-local task created
 * inside a Ritual: it carries only a title + a predicted estimate, is **hidden from
 * the global task list**, and is owned by its ritual (deleting the ritual deletes
 * it). It's an ordinary `tasks` row flagged `is_fast_task = 1` and linked to exactly
 * one pattern via `pattern_tasks`; promoting it to a habit clears the flag.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('is_fast_task')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN is_fast_task INTEGER DEFAULT 0`);
  }
}
