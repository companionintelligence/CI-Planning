import type { Database } from 'better-sqlite3';

export const id = '0084_daily_plan_outcome';

/**
 * Phase N4 — lossy-slip fix.
 *
 * Adds `outcome TEXT` to `daily_plan` so the nightly review can record
 * whether each planned task was completed, deferred, or missed before the
 * block is hard-deleted. Write-once: once stamped, the outcome is never
 * overwritten (checked via `WHERE outcome IS NULL` on all writes).
 *
 * Values: 'deferred' | 'missed' | null (null = still pending / not yet reviewed)
 */
export function up(db: Database): void {
  db.exec(`ALTER TABLE daily_plan ADD COLUMN outcome TEXT;`);
}
