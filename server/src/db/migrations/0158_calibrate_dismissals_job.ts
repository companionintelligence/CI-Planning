import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0158_calibrate_dismissals_job';

/**
 * Seed the weekly `calibrate_dismissals` cron row — close-loop wave, ticket 3. The
 * ONE scheduled job this wave's batch stage adds. Classification of a suggestion
 * stays request-time; the LEARNING from dismissals is batch by contract (never
 * online, never mid-request), so a bad week of dismisses can never bend a live
 * extraction.
 *
 * Monday 04:20 — clear of `calibrate_triality` (Mon 03:50), `calibrate_classification`
 * (Mon 04:10) and `advance_objectives` (Mon 05:00). It runs AFTER
 * `calibrate_classification` deliberately, for the same reason 0150 documents for
 * running after `calibrate_triality`: these are all weekly per-owner learning passes,
 * and serialising them keeps the model calls of one from timing out another on a
 * single-GPU box.
 *
 * The job no-ops harmlessly for an owner below `DISMISSAL_FLOOR` or with no Ollama at
 * all, so seeding it is safe on any deployment. INSERT OR IGNORE keeps the seed
 * idempotent across re-runs.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'calibrate_dismissals', 'calibrate_dismissals', '20 4 * * 1');
}
