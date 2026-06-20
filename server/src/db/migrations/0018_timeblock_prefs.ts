import type { Database } from 'better-sqlite3';

export const id = '0018_timeblock_prefs';

/**
 * Time-Block Settings (Step 2): Plan/Concept config on `scheduling_prefs`.
 *
 *  - **Plans** gain all-day toggles (`plan_allday_always`, and
 *    `plan_daylong_for_promoted` for Concepts promoted to Plans) and an
 *    autoscheduling rule, `plan_autofill_gaps` (let Auto fill free gaps with Plans).
 *    Plan's Max/Min bounds are the existing `max/min_time_block_minutes` (0017) and
 *    its planning horizon reuses `planning_horizon_days`.
 *  - **Concepts** gain a default duration (`concept_default_minutes`; the UI enters
 *    it as Days/Hours/Minutes), their own `concept_horizon_days`, and an
 *    autoscheduling rule `concept_autosurface` (surface a Concept on its goal day).
 *
 * Additive + idempotent (add-column-if-missing).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, sql: string) => { if (!cols.includes(name)) db.exec(sql); };

  add('plan_allday_always', `ALTER TABLE scheduling_prefs ADD COLUMN plan_allday_always INTEGER DEFAULT 0`);
  add('plan_daylong_for_promoted', `ALTER TABLE scheduling_prefs ADD COLUMN plan_daylong_for_promoted INTEGER DEFAULT 0`);
  add('plan_autofill_gaps', `ALTER TABLE scheduling_prefs ADD COLUMN plan_autofill_gaps INTEGER DEFAULT 1`);
  add('concept_default_minutes', `ALTER TABLE scheduling_prefs ADD COLUMN concept_default_minutes INTEGER DEFAULT 60`);
  add('concept_autosurface', `ALTER TABLE scheduling_prefs ADD COLUMN concept_autosurface INTEGER DEFAULT 1`);
  add('concept_horizon_days', `ALTER TABLE scheduling_prefs ADD COLUMN concept_horizon_days INTEGER DEFAULT 30`);
}
