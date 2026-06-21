import type { Database } from 'better-sqlite3';

export const id = '0034_block_recurrence';

/**
 * CON-4 (re-scoped): bare recurring Time Blocks via the SHARED recurrence engine
 * (`engine/recurrence.ts`, rrule.js), mirroring the task recurrence model.
 *
 * **Additive + idempotent + behavior-preserving.** No existing block has a
 * `recurrence_rule`, so the new template/instance machinery is a no-op on current
 * data. The `0025` pattern RRULE path is **kept** (a recurring Routine still places
 * its member tasks lazily on GET) — CON-4 was re-scoped to NOT retire it; this
 * migration only adds the parallel capability for plain Time Blocks.
 *
 * Columns mirror tasks: a *template* has `recurrence_rule` set + `recurrence_parent_id`
 * NULL (never rendered directly); GET materializes one *instance* per occurrence
 * (`recurrence_parent_id` = template, `occurrence_date` = local YYYY-MM-DD). The
 * partial UNIQUE index makes materialization idempotent and concurrency-safe
 * (INSERT OR IGNORE races collapse to one row).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  const add = (name: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE time_blocks ADD COLUMN ${name} TEXT`);
  };
  add('recurrence_rule');
  add('recurrence_dtstart');
  add('recurrence_parent_id');
  add('occurrence_date');

  // One instance per (template, local day). Partial so non-recurring blocks (both
  // columns NULL) are exempt. Idempotency + race-safety for lazy GET placement.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_block_occurrence
       ON time_blocks(recurrence_parent_id, occurrence_date)
       WHERE recurrence_parent_id IS NOT NULL`,
  );
}
