import type { Database } from 'better-sqlite3';

export const id = '0156_capacity_hours_per_week';

/**
 * Replaces the removed `workday_start`/`workday_end` global window as the source
 * for the AI-authoring "capacity today" hint. Per-owner `capacity_hours_per_week`,
 * default 56 (8h/day × 7) — stored in hours to match `sleep_hours_per_week` /
 * `life_priorities.target_hours_per_week`. SQLite has no `ADD COLUMN IF NOT
 * EXISTS`, so guard with a column check (mirrors 0128_sleep_hours). Additive,
 * idempotent, forward-only. `workday_start`/`workday_end` are intentionally left
 * in place, unmigrated — the app just stops reading/writing them.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'capacity_hours_per_week')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN capacity_hours_per_week INTEGER NOT NULL DEFAULT 56;`);
  }
}
