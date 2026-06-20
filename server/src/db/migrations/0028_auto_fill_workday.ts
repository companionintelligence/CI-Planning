import type { Database } from 'better-sqlite3';

export const id = '0028_auto_fill_workday';

/**
 * Make the workday-window fallback secondary + toggleable (PR-C+, Workstream A).
 *
 * Auto now places tag-matched tasks into the user's Plan containers FIRST; the
 * old "fill the 9–6 workday from the front" behaviour becomes a secondary pass
 * gated by this flag. Default ON preserves today's behaviour (workday fallback
 * still runs) — the user can turn it OFF to make Auto fill only the Plans they
 * drew, leaving nothing scheduled outside a container.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('auto_fill_workday')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN auto_fill_workday INTEGER DEFAULT 1`);
  }
}
