import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0167_calibrate_placement_job';

/**
 * Seed the weekly `calibrate_placement` cron row (placement-learning wave, ticket 4) —
 * the ONE scheduled job this ticket adds. Placement itself stays request-time (Auto's
 * `pickGap`); the learning is batch by contract (never online, never mid-request), so a
 * bad week of drags can never bend a live placement.
 *
 * Monday 04:50. This ticket originally claimed 04:30 as "clear against the live seeds
 * in this tree" — true against this branch's own history at the time, but wrong against
 * main: `calibrate_plan_loop` (0163, revision-loop wave) had already claimed 04:30
 * there, merged before this branch caught up. Found by a sibling session cross-referencing
 * schemas post-merge, not by re-deriving the slot list here — re-verify against the live
 * seeds before reusing this number. Real Monday slots as of this merge: `calibrate_triality`
 * `'50 3 * * 1'` (0143), `calibrate_classification` `'10 4 * * 1'` (0150),
 * `calibrate_dismissals` `'20 4 * * 1'` (0158), `calibrate_plan_loop` `'30 4 * * 1'`
 * (0163), `snapshot_balance` `'40 4 * * 1'` (0165), `advance_objectives` `'0 5 * * 1'`
 * (0082). `enrich_tasks` `'20 3 * * *'` (0136) and `calibrate_estimates` `'30 1 * * *'`
 * (0083, moved by 0107) run outside the Monday block. 04:50 is the first clear slot
 * after every one of those — last among the Monday per-owner learning passes, which is
 * still the right place for a loop that never calls a model on a single-GPU box.
 *
 * The job no-ops harmlessly for owners with too few corrections (`CORRECTION_FLOOR`) or
 * no placement evidence at all, so seeding it is safe on any deployment. INSERT OR
 * IGNORE keeps the seed idempotent across re-runs.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'calibrate_placement', 'calibrate_placement', '50 4 * * 1');
}
