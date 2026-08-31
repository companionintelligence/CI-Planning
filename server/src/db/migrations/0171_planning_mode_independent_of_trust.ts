import type { Database } from 'better-sqlite3';

export const id = '0171_planning_mode_independent_of_trust';

/**
 * Split `planning_mode` back out of the trust dial.
 *
 * `loadPlanningPrefs` (agents/plan.ts) used to override the stored preference with
 * `trust_mode === 'hands_off' ? 'smart' : planning_mode`, on the reasoning that
 * hands-off implied full AI autonomy. That conflated two independent axes — how much
 * the planner ACTS on its own (trust_mode) versus how good its ORDERING is
 * (planning_mode) — and made the Settings planning-mode toggle inert for exactly the
 * owners most likely to care about it.
 *
 * With the override gone, `planning_mode` is read as stored. Every hands-off owner who
 * relied on the override still has whatever they last saved — in practice the column
 * default 'basic', since the override meant they never had to touch the toggle. Without
 * this backfill they would silently drop from the LLM generate→judge→revise loop to the
 * deterministic sort on deploy. Pin them to 'smart' so behaviour carries over; they can
 * turn it off in Settings like anyone else.
 *
 * Scoped to hands_off rows only: 'cautious'/'balanced' owners were already being read as
 * stored, so their behaviour does not change and their rows must not be rewritten.
 *
 * Idempotent (re-running finds the rows already 'smart'). Forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'trust_mode')) return;
  if (!hasColumn(db, 'scheduling_prefs', 'planning_mode')) return;
  db.exec(`UPDATE scheduling_prefs SET planning_mode = 'smart' WHERE trust_mode = 'hands_off';`);
}
