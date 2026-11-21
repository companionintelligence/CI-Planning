import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0082_advance_objectives_job';

/**
 * Phase N1 — seeds the daily advance_objectives cadence-push job.
 * The job checks each objective's own cadence before staging its next task.
 * INSERT OR IGNORE keeps the migration idempotent.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'advance_objectives', 'advance_objectives', '0 5 * * *'); // Daily 05:00
}
