import type { Database } from 'better-sqlite3';

export const id = '0035_recall_keeps_pattern';

/**
 * cockpit-v2 Phase 6: recall = clone a shelved (Past) task to a brand-new task.
 * `recall_keeps_pattern` (default OFF) gates whether the clone also copies the
 * original's Routine (pattern) membership — off by default so recalling a shelved
 * habit doesn't silently resurrect a retired Routine.
 *
 * Migration number per consolidation-plan: CON reserves 0030–0034 (CON-3 = 0033 /
 * CON-4 = 0034, not yet built); #77's migrations start at 0035+. Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('recall_keeps_pattern')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN recall_keeps_pattern INTEGER DEFAULT 0`);
  }
}
