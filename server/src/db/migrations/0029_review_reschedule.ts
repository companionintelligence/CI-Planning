import type { Database } from 'better-sqlite3';

export const id = '0029_review_reschedule';

/**
 * Nightly review + reschedule (PR-C+, Workstream B).
 *
 * A task can be *missed*: its planned block's time passed and it was never
 * started. The `review_day` cron (01:00, reviewing the day that just closed)
 * finds these and acts hybrid-by-priority:
 *   - low priority (>= 3) → auto-defer with a +1/3/7-day backoff;
 *   - high priority (<= 2) → mark `status='missed'` and surface for the user to
 *     reschedule (no silent move).
 *
 * `defer_count` tracks how many times a task has been pushed, which drives the
 * backoff schedule (0→+1d, 1→+3d, 2+→+7d). Unlike the (removed) place_patterns
 * cron, this one IS correctly time-triggered: it's a once-a-day judgment about
 * the past, not something derivable from a read.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('defer_count')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN defer_count INTEGER DEFAULT 0`);
  }
  db.exec(`INSERT OR IGNORE INTO scheduled_jobs (name, kind, cron)
           VALUES ('review_day', 'review_day', '0 1 * * *')`);
}
