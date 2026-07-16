import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0130_purge_objectives_job';

/**
 * Seeds the `purge_objectives` job — the reaper behind the archive's 48h reversal
 * window (0129). It hard-deletes objectives whose `purge_after` deadline has passed;
 * until then "delete permanently" is a single UPDATE away from being undone.
 *
 * HOURLY, not nightly: `purge_after` is an absolute deadline, so a nightly job would
 * land the purge anywhere from 48h to 72h out and make a countdown UI a lie by up to
 * a day. Hourly keeps "deletes in about 47 hours" true (48–49h).
 *
 * GLOBAL, not per-owner (see jobs/index.ts OWNER_SCOPED_KINDS): the deadline is
 * absolute UTC with no owner-tz dependency, so this is the prune_sync_events shape,
 * whose comment records that owner-scoping this kind of retention was a BUG that let
 * every non-first owner's rows grow unbounded.
 *
 * INSERT OR IGNORE keeps it idempotent; `scheduled_jobs.name` is UNIQUE and the id is
 * an explicit TEXT UUIDv7 (the table has no AUTOINCREMENT).
 *
 * NOTE: startCronJobs() reads scheduled_jobs once at boot, so this only takes effect
 * on server RESTART.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'purge_objectives', 'purge_objectives', '0 * * * *'); // hourly
}
