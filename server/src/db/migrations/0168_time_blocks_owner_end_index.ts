import type { Database } from 'better-sqlite3';

export const id = '0168_time_blocks_owner_end_index';

/**
 * Balance-targets wave, code-review follow-up — cover the interval-overlap query
 * `services/balance-budget.ts`'s `SQL_BLOCK_CATEGORY_MINUTES` uses
 * (`start_at <= ? AND end_at >= ?`), now on a hot path: `dimensionShortfalls` runs
 * on every flight-plan fill and every day-authoring call (tickets 3/4).
 *
 * The existing `ix_time_blocks_owner_start(owner_id, start_at)` (0099) only bounds
 * the upper side of the window — SQLite seeks `start_at <= endUtc` but has no index
 * to prune the lower side (`end_at >= startUtc`), so it scans everything in the
 * owner's ENTIRE block history that hasn't started in the future, filtering `end_at`
 * as a residual check per row (verified with `EXPLAIN QUERY PLAN`).
 *
 * Every caller of this query targets a RECENT week (the current week for the live
 * bias, last week for the snapshot job) — never an arbitrary past week — so a second
 * index on `(owner_id, end_at)` lets SQLite instead seek `end_at >= startUtc`, which
 * for a recent window prunes away everything that ended more than a week or two ago:
 * the vast majority of an active owner's history. The query planner picks whichever
 * index its cost estimate favors; both are available so the choice is safe either way.
 *
 * Purely additive + idempotent (CREATE INDEX IF NOT EXISTS). No data change, no
 * behavior change, no schema.ts change (indexes aren't modeled in drizzle here).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_time_blocks_owner_end ON time_blocks(owner_id, end_at);
  `);
}
