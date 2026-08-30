import type { Database } from 'better-sqlite3';

export const id = '0164_balance_bias_pref';

/**
 * Balance-targets wave (bal-2) — the master gate for the auto-planning bias tickets
 * 3/4 add: when ON, candidate ordering and slot placement nudge toward life
 * dimensions running behind their stated weekly target. Default ON per owner ruling
 * 2026-08-29 — this ticket only adds the column and wires it end-to-end; no
 * engine/agents code reads it yet (tickets 3/4). The suggest surface (ticket 5) and
 * the weekly snapshot (ticket 6) are deliberately NOT gated by this flag — they are
 * pure-read surfaces, like the drawer. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
 * guard with a column check (mirrors 0156_capacity_hours_per_week). Additive,
 * idempotent, forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'balance_bias_enabled')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN balance_bias_enabled INTEGER NOT NULL DEFAULT 1;`);
  }
}
