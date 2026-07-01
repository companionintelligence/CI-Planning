import type { Database } from 'better-sqlite3';

export const id = '0086_objective_source_task';

/**
 * Marks objectives auto-created by task promotion (a task that gained a subtask)
 * with the task they were promoted from. This makes auto-promotion:
 *   - idempotent by OWNER task (reuse only THIS task's objective, never an unrelated
 *     manually-linked one),
 *   - garbage-collectable (delete the objective when its source task's subtasks/parent
 *     go away, so childless auto-objectives don't accumulate),
 *   - always a leaf (a promoted objective only ever holds tasks).
 * Null for manually-created objectives. No FK (sqlite can't ALTER-ADD one); the
 * promotion service scopes by owner and deletes explicitly.
 */
export function up(db: Database): void {
  db.exec(`ALTER TABLE objectives ADD COLUMN source_task_id TEXT;`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_objectives_source_task ON objectives(source_task_id);`);
}
