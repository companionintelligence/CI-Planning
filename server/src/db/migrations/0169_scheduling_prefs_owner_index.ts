import type { Database } from 'better-sqlite3';

export const id = '0169_scheduling_prefs_owner_index';

/**
 * `scheduling_prefs` has no index on `owner_id` — 0092 (Q2, FK indexes) covered every
 * other hot cascade/join path and explicitly noted "owner_id columns already have
 * indexes," but this table's only index is its own `id` primary key. `ownerTimezone`
 * (`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`) is one of the most
 * frequently called reads in the codebase — every learning loop, every timezone-aware
 * placement, and (since the placement-learning wave) every drag/resize PATCH that
 * closes an open `placement_log` row all call it — and until now every one of those
 * calls did a full table scan, confirmed via `EXPLAIN QUERY PLAN`.
 *
 * Negligible today (one row per owner), but cheap to fix now rather than carry an
 * unindexed scan on a request path forward as the table's row count grows with the
 * owner base. Purely additive + idempotent, same as 0092: no data change, no behavior
 * change, no schema.ts change (indexes aren't modeled in drizzle here).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_scheduling_prefs_owner ON scheduling_prefs(owner_id);
  `);
}
