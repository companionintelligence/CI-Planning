import type { Database } from 'better-sqlite3';

export const id = '0128_sleep_hours';

/**
 * Onboarding Priorities Wizard — reserve weekly SLEEP as unschedulable time
 * (attributed to Health). Per-owner `sleep_hours_per_week`, default 63 (9h/night × 7);
 * the wizard's schedulable pool is 168 − this. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so guard with a column check (mirrors 0070_trust_mode). Additive, idempotent,
 * forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'sleep_hours_per_week')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN sleep_hours_per_week INTEGER NOT NULL DEFAULT 63;`);
  }
}
