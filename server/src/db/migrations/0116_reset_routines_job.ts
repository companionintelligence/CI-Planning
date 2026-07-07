import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0116_reset_routines_job';

/**
 * Seeds the daily `reset_routines` job. Routine tasks are a repeatable checklist —
 * they are never archived; at midnight any completed routine member flips back to
 * `open` so the routine is fresh for the new day. Runs at 00:00 (process tz = UTC
 * baseline, as everywhere). INSERT OR IGNORE keeps the migration idempotent.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'reset_routines', 'reset_routines', '0 0 * * *'); // daily 00:00
}
