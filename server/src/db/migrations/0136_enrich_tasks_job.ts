import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0136_enrich_tasks_job';

/**
 * Seeds the nightly `enrich_tasks` cron job (handoff D4): pull related items from
 * Companion Intelligence for recent under-described tasks and fill in a description +
 * direction.
 *
 * Nightly at 03:20 rather than hourly like `tag_tasks`: each task costs a CI-Server
 * round-trip AND a model call, so this is the expensive sweep — and unlike tagging, a
 * description is not time-critical. 03:20 keeps it clear of the 03:00 auto_schedule and
 * the 02:00 snapshot/grooming band.
 *
 * The job no-ops with an honest log when MEMORY_MODE is unset (the connector reports
 * off), so seeding it is safe on a deployment that never configures memory.
 * INSERT OR IGNORE keeps the seed idempotent across re-runs.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'enrich_tasks', 'enrich_tasks', '20 3 * * *');
}
