import type { Database } from 'better-sqlite3';

export const id = '0146_ingest_gmail_15m';

/**
 * Tighten the Gmail ingest cadence from every 30 minutes to every 15, so email-derived
 * suggestions surface roughly twice as fast.
 *
 * GUARDED UPDATE (the 0107_calibration_scope.ts precedent): the `AND cron = '<old>'`
 * predicate means this only rewrites the value seeded by 0003_seed_defaults.ts and
 * leaves an operator's manual edit alone. 0003 itself is untouched — applied migrations
 * are immutable, and a fresh database simply runs 0003 then this.
 *
 * TAKES EFFECT ON RESTART ONLY. `startCronJobs()` (jobs/index.ts) reads `scheduled_jobs`
 * once at boot and hands each expression to its Cron instance; a running process keeps
 * the old schedule until it is restarted.
 *
 * Note this changes only how OFTEN the job runs, not whether it can do anything: on a
 * deployment whose MCP server exposes no Gmail tools the job still no-ops (see
 * mcp/gmail-flag.ts + the tool-contract assertion in mcp/client.ts).
 */
export function up(db: Database): void {
  db.prepare(
    `UPDATE scheduled_jobs SET cron = '*/15 * * * *' WHERE kind = 'ingest_gmail' AND cron = '*/30 * * * *'`,
  ).run();
}
