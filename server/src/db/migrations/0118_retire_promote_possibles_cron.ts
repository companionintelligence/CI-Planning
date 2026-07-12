import type { Database } from 'better-sqlite3';

export const id = '0118_retire_promote_possibles_cron';

/**
 * AF-3 — retire the standalone `promote_possibles` cron (seeded 0003, '0 2 * * *').
 * Promotion is now unconditional and happens at ingestion (services/possibles.ts
 * `promoteAllPending` at the end of every producer batch); `nightly_grooming` keeps a
 * `promotePossibles()` sweep for stragglers, subsuming this job. The execute() case for
 * the kind survives for manual invocations; only the scheduled row is removed.
 *
 * DELETEs are naturally idempotent. Forward-only. Pattern follows
 * 0026_drop_place_patterns_cron: job_runs.job_id → scheduled_jobs.id has no ON DELETE
 * action, so drop the run history first or the parent delete violates the FK.
 */
export function up(db: Database): void {
  db.prepare(
    `DELETE FROM job_runs WHERE job_id IN (SELECT id FROM scheduled_jobs WHERE kind = 'promote_possibles')`,
  ).run();
  db.prepare(`DELETE FROM scheduled_jobs WHERE kind = 'promote_possibles'`).run();
}
