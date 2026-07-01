import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0090_freeze_stars_job';

/**
 * Phase O · O2 — seeds the nightly freeze_stars job.
 * Runs at 00:20 local, snapshotting the five-star score for the day that just
 * ended into day_stars so a frozen past day never recomputes.
 * INSERT OR IGNORE keeps the migration idempotent.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'freeze_stars', 'freeze_stars', '20 0 * * *'); // 00:20 daily
}
