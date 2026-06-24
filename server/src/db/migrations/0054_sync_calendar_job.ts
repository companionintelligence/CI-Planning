import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0054_sync_calendar_job';

/**
 * Phase J (PR2) — seed the sync_calendar cron job. Runs every 15 minutes;
 * frequent enough for a planned block to reach the calendar within one cycle
 * (acceptance criterion J-A1). INSERT OR IGNORE keeps the seed idempotent.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'Calendar Sync', 'sync_calendar', '*/15 * * * *');
}
