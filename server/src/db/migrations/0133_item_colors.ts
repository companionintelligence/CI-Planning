import type { Database } from 'better-sqlite3';

export const id = '0133_item_colors';

/**
 * #391 — per-ITEM colours for routines/habits (patterns rows) and objectives.
 *
 * Colour existed only per-TYPE until now (`pattern_types.color_token`, mig 0017):
 * every Routine shared one colour, every Habit another, and objectives had none.
 * These columns are the item layer; display resolution everywhere is
 * `item.color_token ?? type.color_token ?? 'primary'` (objectives:
 * `color_token ?? hash` — the Planner accent's fallback).
 *
 * Values are CI-Hub token keys ('chart-2', 'tag-7', …), never hex — the same
 * vocabulary as tag_prefs.color_token. Nullable with NO default (NULL = inherit):
 * SQLite forbids a non-constant DEFAULT on ADD COLUMN and NOT NULL would force a
 * table rebuild (the 0129 idiom). No index — never queried by colour.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'patterns', 'color_token')) {
    db.exec(`ALTER TABLE patterns ADD COLUMN color_token TEXT;`);
  }
  if (!hasColumn(db, 'objectives', 'color_token')) {
    db.exec(`ALTER TABLE objectives ADD COLUMN color_token TEXT;`);
  }
}
