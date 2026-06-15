import type { Database } from 'better-sqlite3';

export const id = '0008_recurrence';

/**
 * Recurrence model on `tasks`. Additive only — no table rebuild.
 *
 * A *template* row has `recurrence_rule != null` and `recurrence_parent_id = null`.
 * An *instance* row has `recurrence_parent_id = <template>` and `occurrence_date`
 * set; it is an ordinary task the existing scheduler already handles. `is_habit`
 * propagates template→instance.
 *
 * The rule string is RFC-5545 RRULE; expansion is owned by `engine/recurrence.ts`
 * (rrule.js for the pattern) + `lib/tz.ts` (for every wall-clock→UTC instant).
 * This migration only widens the schema — no behavior change yet.
 */
export function up(db: Database): void {
  // addColumn-if-missing keeps this idempotent for baseline adoption / re-runs.
  const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, sql: string) => {
    if (!cols.includes(name)) db.exec(sql);
  };

  add('recurrence_rule', `ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT`); // RRULE string, null = one-off
  add('recurrence_parent_id', `ALTER TABLE tasks ADD COLUMN recurrence_parent_id INTEGER REFERENCES tasks(id)`);
  add('recurrence_dtstart', `ALTER TABLE tasks ADD COLUMN recurrence_dtstart TEXT`); // UTC ISO anchor of the series
  add('recurrence_exdates', `ALTER TABLE tasks ADD COLUMN recurrence_exdates TEXT`); // JSON string[]: skipped local dates
  add('occurrence_date', `ALTER TABLE tasks ADD COLUMN occurrence_date TEXT`); // local YYYY-MM-DD of THIS instance
  add('is_habit', `ALTER TABLE tasks ADD COLUMN is_habit INTEGER DEFAULT 0`);

  // Idempotency guard: at most one materialized instance per (template, occurrence date).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_task_occurrence
           ON tasks(recurrence_parent_id, occurrence_date)
           WHERE recurrence_parent_id IS NOT NULL`);

  // Scale-budget index: generator / scheduler scan owner + status + due cheaply.
  db.exec(`CREATE INDEX IF NOT EXISTS ix_task_owner_status_due ON tasks(owner_id, status, due_at)`);
}
