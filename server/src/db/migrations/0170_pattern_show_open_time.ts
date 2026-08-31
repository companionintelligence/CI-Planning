import type { Database } from 'better-sqlite3';

export const id = '0170_pattern_show_open_time';

/**
 * Today's Open Time card used to hardcode which directions count as placement
 * capacity (`OPEN_TIME_DIRECTIONS = ['work', 'community']` on the client) — home
 * windows never appeared no matter how they were configured. Per owner request
 * 2026-08-30, that's now a per-direction preference living beside the pattern's
 * own windows in the "Edit windows" panel, instead of a baked-in constant.
 *
 * Default ON for every direction (including home): the card should show whatever
 * windows are configured unless the owner turns a direction off. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so guard with a column check (mirrors 0164). Additive,
 * idempotent, forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'tag_prefs', 'show_open_time')) {
    db.exec(`ALTER TABLE tag_prefs ADD COLUMN show_open_time INTEGER NOT NULL DEFAULT 1;`);
  }
}
