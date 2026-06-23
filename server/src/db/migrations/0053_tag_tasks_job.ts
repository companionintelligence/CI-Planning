import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0053_tag_tasks_job';

/**
 * Seeds the hourly `tag_tasks` cron job. Runs every hour (`0 * * * *`) — a
 * sensible cadence for a tagging pass: frequent enough to catch tasks shortly
 * after they arrive via ingest (which runs every 30 min), without being
 * noisy. INSERT OR IGNORE keeps the seed idempotent across re-runs.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'tag_tasks', 'tag_tasks', '0 * * * *');
}
