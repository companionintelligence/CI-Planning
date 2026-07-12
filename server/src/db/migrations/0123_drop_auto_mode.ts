import type { Database } from 'better-sqlite3';

export const id = '0123_drop_auto_mode';

/**
 * Z · W4 — drop the vestigial scheduling_prefs.auto_mode column.
 * (Renumbered 0122→0123 at merge: #325's 0122_scrub_seed_owner landed on main first —
 * the same renumber-at-merge precedent as 0119→0121.)
 *
 * 0070 introduced trust_mode and repointed every reader; auto_mode has had NO server
 * reader since. But the top-bar Suggest/Schedule toggle kept WRITING it until the
 * toggle was repointed to trust_mode (same change-set as this migration) — so an
 * owner who clicked "Schedule" after 0070 recorded intent that never reached
 * trust_mode. Carry that intent forward before dropping: 'schedule' upgrades a
 * still-default 'balanced' to 'hands_off' (the behavior the toggle promised).
 * A non-default trust_mode ('cautious'/'hands_off') is an explicit post-0070 choice
 * (API/GraphQL — no UI wrote it) and is never overridden.
 *
 * DROP COLUMN is safe: SQLite ≥3.35, the column is not indexed and no code
 * references it. Idempotent via the column guard (0052/0061 precedent).
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'auto_mode')) return;
  db.exec(`UPDATE scheduling_prefs SET trust_mode = 'hands_off' WHERE auto_mode = 'schedule' AND trust_mode = 'balanced';`);
  db.exec(`ALTER TABLE scheduling_prefs DROP COLUMN auto_mode;`);
}
