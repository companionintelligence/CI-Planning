import type { Database } from 'better-sqlite3';

export const id = '0176_motivation_recap_pref';

/**
 * Per-owner opt-in for the me / us / them balance block in the weekly recap
 * (`GET /api/plan-week/review`). Default OFF (0): with it off the recap payload is byte-identical
 * to before, and nothing here is computed. A plain scheduling_prefs boolean, the
 * `triality_enabled` shape (0139). Idempotent via the addColumn-if-missing pattern.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'motivation_recap_enabled')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN motivation_recap_enabled INTEGER NOT NULL DEFAULT 0`);
  }
}
