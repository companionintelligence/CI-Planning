import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0163_calibrate_plan_loop_job';

/**
 * Seed the weekly `calibrate_plan_loop` cron row (ticket 3) — the deterministic
 * BATCH pass over `plan_loop_runs` (0162). Monday 04:30: after `calibrate_classification`
 * (04:10 Monday), before `advance_objectives` (05:00 Monday). This job makes NO model
 * calls — it is pure SQL aggregation — but the weekly learning passes stay serialized
 * in one block so the schedule reads as one unit. Clear of the daily 03:00
 * `prune_sync_events` / 03:20 `enrich_tasks` and the nightly 01:30 `calibrate_estimates`
 * (moved off its original Sunday 04:00 slot by migration 0107).
 *
 * INSERT OR IGNORE keeps the seed idempotent across re-runs.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'calibrate_plan_loop', 'calibrate_plan_loop', '30 4 * * 1');
}
