import type { Database } from 'better-sqlite3';

export const id = '0066_auto_defense_enabled';

/**
 * B2 — `scheduling_prefs.auto_defense_enabled` gates reactive reflow (requestReplan).
 * Default ON: reflow is bounded (anti-thrash) and, once B4 lands, nudge-gated, so the
 * safe default is to defend the day automatically. Users can disable it in Settings.
 *
 * Additive + idempotent. Forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'auto_defense_enabled')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN auto_defense_enabled INTEGER NOT NULL DEFAULT 1;`);
  }
}
