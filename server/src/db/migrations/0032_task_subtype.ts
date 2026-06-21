import type { Database } from 'better-sqlite3';

export const id = '0032_task_subtype';

/**
 * CON-2c: add the canonical `tasks.subtype` (`'standard' | 'habit' | 'quick'`) —
 * the GLOSSARY's mutually-exclusive Task subtype, surfaced at the UI/API layer.
 *
 * **ADDITIVE (decided with the user).** `is_habit` / `is_fast_task` stay as
 * in-sync runtime aliases: the recurrence generation, streaks, and skip logic
 * keep reading `is_habit` untouched. Dropping the booleans is a later contract
 * step, explicitly out of scope here. The backfill seeds subtype from the
 * existing booleans (habit wins ties). Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('subtype')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN subtype TEXT DEFAULT 'standard'`);
  }
  // Backfill from the legacy booleans — habit wins ties (a habit is never a quick task).
  db.exec(`UPDATE tasks SET subtype = 'habit' WHERE is_habit = 1;`);
  db.exec(`UPDATE tasks SET subtype = 'quick' WHERE is_fast_task = 1 AND (is_habit IS NULL OR is_habit = 0);`);
}
