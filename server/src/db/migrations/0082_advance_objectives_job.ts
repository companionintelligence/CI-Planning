import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0082_advance_objectives_job';

/**
 * Phase N1 — seeds the weekly advance_objectives cadence-push job.
 * Runs Monday at 05:00 (same day as the weekly review) so the morning ritual
 * presents objective-nominated tasks as one grouped section.
 * INSERT OR IGNORE keeps the migration idempotent.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'advance_objectives', 'advance_objectives', '0 5 * * 1'); // Mon 05:00
}
