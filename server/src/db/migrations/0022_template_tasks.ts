import type { Database } from 'better-sqlite3';

export const id = '0022_template_tasks';

/**
 * Save-a-block-with-its-tasks (PR-B). A `block_templates` row can now carry the
 * tasks that sat inside the saved Plan — a JSON array of
 * `{ title, tag, estimated_minutes, offset_minutes }` (offset = minutes from the
 * block start to the task's start). Instantiating recreates the container *and*
 * those tasks at the same relative offsets.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(block_templates)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('tasks')) db.exec(`ALTER TABLE block_templates ADD COLUMN tasks TEXT`); // JSON {title,tag,estimated_minutes,offset_minutes}[]
}
