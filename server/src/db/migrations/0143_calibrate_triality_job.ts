import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0143_calibrate_triality_job';

/**
 * Seed the weekly `calibrate_triality` cron row (docs/triality-design.md §6b) —
 * the ONE scheduled job Triality adds. The suggestion path itself stays
 * request-time only; learning is deliberately batch (never online, never
 * mid-request), so a bad week of feedback can never bend a live ranking.
 *
 * Monday 03:50, chosen to sit clear of every existing row (03:00
 * prune_sync_events, 03:20 enrich_tasks, 05:00 Monday advance_objectives) so
 * the weekly pass never contends with the nightly stack.
 *
 * The job no-ops harmlessly for owners with the flag off or too little decided
 * feedback (the §6b floor), so seeding it is safe on a deployment that never
 * enables Triality. INSERT OR IGNORE keeps the seed idempotent across re-runs.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'calibrate_triality', 'calibrate_triality', '50 3 * * 1');
}
