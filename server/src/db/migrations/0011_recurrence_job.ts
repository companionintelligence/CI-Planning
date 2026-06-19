import type { Database } from 'better-sqlite3';

export const id = '0011_recurrence_job';

/**
 * Seed the recurrence generation job (Phase E, PR-2). Idempotent via INSERT OR
 * IGNORE on the unique `name`.
 *
 * Cron 02:45 — deliberately *before* `auto_schedule` (03:00) so the night's freshly
 * materialized instances exist when the day is packed (instances are plain `open`
 * tasks the scheduler then sees). The generator is also callable on demand after a
 * template create/edit (PR-3) so a new series appears immediately, not next night.
 */
export function up(db: Database): void {
  db.prepare(`INSERT OR IGNORE INTO scheduled_jobs (name, kind, cron) VALUES (?, ?, ?)`).run(
    'generate_recurrences',
    'generate_recurrences',
    '45 2 * * *'
  );
}
