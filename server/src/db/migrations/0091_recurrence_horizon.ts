import type { Database } from 'better-sqlite3';

export const id = '0091_recurrence_horizon';

/**
 * Phase P · P1 — `recurrence_horizon_days` on scheduling_prefs: how many days
 * ahead (from today, inclusive) the two lazy recurrence engines materialize —
 * `ensurePatternsForRange` (patterns-place.ts) + `ensureRecurringBlocksForRange`
 * (blocks-recur.ts). Default 7. Bounds the "planner fills its far future with
 * repeats" problem: navigating past the horizon no longer creates new instances.
 *
 * Distinct from `planning_horizon_days` (the auto-scheduler "today set" window).
 * The Settings select offers {7,15,30,60,90,180}; the PATCH route enforces that
 * set and auto-prunes engine-generated instances beyond a lowered horizon.
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('recurrence_horizon_days')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN recurrence_horizon_days INTEGER DEFAULT 7`);
  }
}
