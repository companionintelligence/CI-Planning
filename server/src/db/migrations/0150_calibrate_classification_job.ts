import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0150_calibrate_classification_job';

/**
 * Seed the weekly `calibrate_classification` cron row (Phase 8) — the ONE scheduled
 * job classification learning adds. Classification itself stays request-time; the
 * learning is batch by contract (never online, never mid-request), so a bad week of
 * corrections can never bend a live answer.
 *
 * Monday 04:10, clear of every existing row — 03:20 enrich_tasks, 03:30
 * calibrate_estimates, 03:50 Monday calibrate_triality, 05:00 Monday
 * advance_objectives. It runs AFTER calibrate_triality deliberately: both are weekly
 * per-owner learning passes, and serialising them keeps the model calls of one from
 * timing out the other on a single-GPU box.
 *
 * The job no-ops harmlessly for owners with too few corrections (the floor) or no
 * Ollama at all, so seeding it is safe on any deployment. INSERT OR IGNORE keeps the
 * seed idempotent across re-runs.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'calibrate_classification', 'calibrate_classification', '10 4 * * 1');
}
