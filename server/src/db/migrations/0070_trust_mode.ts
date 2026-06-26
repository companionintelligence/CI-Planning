import type { Database } from 'better-sqlite3';

export const id = '0070_trust_mode';

/**
 * Trust dial (FTUE gaps 5 & 6) — the 3-state automation Setting that replaces the
 * 2-state `auto_mode` toggle:
 *   - 'cautious'  : nothing auto-promotes; nothing auto-blocks.
 *   - 'balanced'  : high-confidence possibles auto-promote (= old 'suggest'); no auto-block.
 *   - 'hands_off' : auto-promote AND auto-block promoted tasks that carry an estimate
 *                   (= old 'schedule', now also firing at the promotion boundary).
 *
 * SQLite can't cleanly change an existing column's DEFAULT, so this ADDS a new column
 * (default 'balanced' = today's behavior) and backfills 'hands_off' from any row that had
 * `auto_mode='schedule'`. `auto_mode` is left in place (vestigial once the readers repoint;
 * a later contract migration drops it).
 *
 * Additive + idempotent. Forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'trust_mode')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN trust_mode TEXT NOT NULL DEFAULT 'balanced';`);
  }
  // Backfill from the legacy auto_mode toggle so an existing Schedule-mode owner keeps
  // their zero-click behavior. Guarded: 0.2-era DBs may pre-date auto_mode.
  if (hasColumn(db, 'scheduling_prefs', 'auto_mode')) {
    db.exec(`UPDATE scheduling_prefs SET trust_mode = 'hands_off' WHERE auto_mode = 'schedule';`);
  }
}
