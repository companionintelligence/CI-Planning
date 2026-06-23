import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0047_snapshot_job';

/**
 * Phase R — seeds the daily DB snapshot job. INSERT OR IGNORE keeps it idempotent;
 * id is minted here (no autoincrement default post-CON-1, same as 0036/0044).
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`
  ).run(newId(), 'snapshot_db', 'snapshot_db', '0 2 * * *'); // daily at 02:00
}
