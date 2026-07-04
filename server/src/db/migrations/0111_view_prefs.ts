import type { Database } from 'better-sqlite3';

export const id = '0111_view_prefs';

/**
 * Cross-device persistence for calendar UI view-state.
 *
 * Adds a single nullable JSON blob column `view_prefs` to `scheduling_prefs`.
 * NULL = "no saved view state" → the client falls back to its built-in defaults
 * (calendar filter = all shown, night-hour collapse = both collapsed). Keeping it
 * one extensible blob (rather than a column per toggle) means new view surfaces —
 * the deferred Planner collapse (`view_prefs.planner`), future overlays — add a
 * key, not a migration.
 *
 * Shape (all keys optional, client stays forgiving):
 *   { calendar?: { deselected?: { direction?: string[]; intention?: string[]; category?: string[] },
 *                  prio?: number[], topExpanded?: boolean, bottomExpanded?: boolean } }
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
 * Nullable, no NOT NULL default, so raw-insert test fixtures are unaffected.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('view_prefs')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN view_prefs TEXT`); // JSON blob; NULL = no saved view state
  }
}
