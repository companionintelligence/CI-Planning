import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0167_calibrate_placement_job';

/**
 * Seed the weekly `calibrate_placement` cron row (placement-learning wave, ticket 4) —
 * the ONE scheduled job this ticket adds. Placement itself stays request-time (Auto's
 * `pickGap`); the learning is batch by contract (never online, never mid-request), so a
 * bad week of drags can never bend a live placement.
 *
 * Monday 04:30, verified clear against the live seeds in this tree: `enrich_tasks`
 * `'20 3 * * *'` (0136), `calibrate_triality` `'50 3 * * 1'` (0143),
 * `calibrate_classification` `'10 4 * * 1'` (0150), `advance_objectives` `'0 5 * * 1'`
 * (0082), and `calibrate_estimates` — nightly, not Sunday 04:00: seeded `'0 4 * * 0'` by
 * 0083, moved to `'30 1 * * *'` by 0107. It runs LAST among the Monday per-owner
 * learning passes deliberately: this loop never calls a model, so it must not sit ahead
 * of ones that might on a single-GPU box.
 *
 * The job no-ops harmlessly for owners with too few corrections (`CORRECTION_FLOOR`) or
 * no placement evidence at all, so seeding it is safe on any deployment. INSERT OR
 * IGNORE keeps the seed idempotent across re-runs.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'calibrate_placement', 'calibrate_placement', '30 4 * * 1');
}
