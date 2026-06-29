import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0078_prune_sync_events_job';

/**
 * Phase L — seeds the daily sync_events pruning job.
 * sync_events grows at ~1 row per mutation with no retention bound; this job
 * deletes rows older than 30 days, which generously exceeds any realistic
 * offline-reconnect gap (devices offline longer than that receive sync:resync).
 * INSERT OR IGNORE keeps the migration idempotent.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'prune_sync_events', 'prune_sync_events', '0 3 * * *'); // daily at 03:00
}
