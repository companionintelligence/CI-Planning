import type { Database } from 'better-sqlite3';

export const id = '0092_fk_indexes';

/**
 * Q2 (schema hygiene) — cover the FK columns on hot cascade/join paths that
 * lacked a supporting index. Without one, a cascade delete (task -> blocks ->
 * reminders …) or a self-join (subtask / recurrence hierarchy) full-scans the
 * child table. Harmless at today's row counts, but the first thing to slow down
 * once multi-tenant + growth arrive. owner_id columns (and the parent/pattern-
 * source/time-entries/objective FKs) already have indexes and are NOT re-added.
 *
 * Purely additive + idempotent (CREATE INDEX IF NOT EXISTS). No data change, no
 * behavior change, no schema.ts change (indexes aren't modeled in drizzle here).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_time_blocks_task           ON time_blocks(task_id);
    CREATE INDEX IF NOT EXISTS ix_time_blocks_category       ON time_blocks(category_id);
    CREATE INDEX IF NOT EXISTS ix_reminders_task             ON reminders(task_id);
    CREATE INDEX IF NOT EXISTS ix_reminders_block            ON reminders(block_id);
    CREATE INDEX IF NOT EXISTS ix_tasks_parent               ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS ix_tasks_recurrence_parent    ON tasks(recurrence_parent_id);
    CREATE INDEX IF NOT EXISTS ix_job_runs_job               ON job_runs(job_id);
    CREATE INDEX IF NOT EXISTS ix_daily_plan_block           ON daily_plan(block_id);
    CREATE INDEX IF NOT EXISTS ix_possible_tasks_proposed_owner ON possible_tasks(proposed_owner_id);
    CREATE INDEX IF NOT EXISTS ix_possible_tasks_promoted_task  ON possible_tasks(promoted_task_id);
  `);
}
