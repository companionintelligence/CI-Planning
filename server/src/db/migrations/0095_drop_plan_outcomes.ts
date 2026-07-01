import type { Database } from 'better-sqlite3';

export const id = '0095_drop_plan_outcomes';

/**
 * S1-A (schema consolidation) — drop the dead `plan_outcomes` table and retire
 * its nightly `aggregate_plan_outcomes` cron.
 *
 * `plan_outcomes` (created 0083) was written every night by the aggregate job but
 * read by NO production code path (route, engine, or client) — only tests. It's a
 * regenerable rollup (planned-vs-completed task-blocks per day), trivially
 * re-derivable on demand from `time_blocks`+`tasks` if a reader is ever needed, so
 * there's nothing to preserve. Removing it also removes a nightly job that wrote
 * data no one consumed.
 *
 * The cron seed was an INSERT OR IGNORE in the already-applied 0083, so it can't be
 * un-seeded by editing 0083 — this migration deletes the scheduled_jobs row so the
 * cron runner stops firing a job whose table (and handler) are gone.
 *
 * `plan_outcomes` is a LEAF table (nothing FK-references it), so DROP under FK-on is
 * safe — no `manual`/foreign_keys toggle needed. Forward-only + idempotent
 * (IF EXISTS + a DELETE that's a no-op when the row is already gone).
 */
export function up(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS plan_outcomes;
    DELETE FROM scheduled_jobs WHERE kind = 'aggregate_plan_outcomes';
  `);
}
