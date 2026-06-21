import type { Database } from 'better-sqlite3';

export const id = '0026_drop_place_patterns_cron';

/**
 * The `place_patterns` cron is gone (PR-C+, Phase D refactor). Pattern
 * placement is now lazy on `GET /api/blocks`, so a background cron is no
 * longer required for a recurring Habit/Routine to render on the day's board.
 *
 * Migration 0025 originally seeded a row; this migration removes it for any
 * dev/prod DB that already had it. Fresh DBs never see the row because
 * 0025's INSERT has been removed.
 *
 * Idempotent — a DB that never had the row is a no-op.
 */
export function up(db: Database): void {
  // job_runs.job_id → scheduled_jobs.id has no ON DELETE action; drop the
  // dependent rows first so the parent delete satisfies the FK.
  db.prepare(`DELETE FROM job_runs WHERE job_id IN (SELECT id FROM scheduled_jobs WHERE kind = 'place_patterns')`).run();
  db.prepare(`DELETE FROM scheduled_jobs WHERE kind = 'place_patterns'`).run();
}
