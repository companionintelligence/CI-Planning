import type { Database } from 'better-sqlite3';

export const id = '0042_fix_recurrence_subtype';

/**
 * Corrective backfill for the recurrence-generation subtype bug (CON-2c).
 *
 * `engine/recurrence-generate.ts` copied a template's `is_habit` onto each
 * generated instance but NOT its canonical `subtype`, so every instance fell back
 * to the column default `'standard'`. A habit template therefore produced
 * instances with `is_habit=1` / `subtype='standard'` — incoherent, and streamed to
 * clients over SSE. The code is fixed to propagate `subtype`; this repairs the rows
 * already written by the buggy generator.
 *
 * Repair = restore the canonical invariant `is_habit=1 ⇒ subtype='habit'`. That
 * targets exactly the mis-generated habit instances. It deliberately does NOT touch
 * `subtype='habit'` rows (so it can't fight the `is_fast_task`-coherence fix in the
 * same release), and there is no `quick` case to repair: instances are inserted
 * without `is_fast_task`, so no instance is `subtype='quick'`.
 *
 * Idempotent (`subtype IS NOT 'habit'` guard; `IS NOT` also covers any NULL).
 */
export function up(db: Database): void {
  db.exec(`UPDATE tasks SET subtype = 'habit' WHERE is_habit = 1 AND subtype IS NOT 'habit';`);
}
