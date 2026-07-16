import type { Database } from 'better-sqlite3';

export const id = '0129_objective_archive';

/**
 * Objectives archive + deferred purge (owner request 2026-07-15).
 *
 * Deleting an objective used to destroy the row. It now archives: hidden from the
 * live tree, kept indefinitely, restorable. A separate "delete permanently" stamps
 * `purge_after`, and an hourly job (0130) reaps rows past the deadline — so the
 * reversal window is free, because the row never leaves the table.
 *
 * WHY A COLUMN AND NOT `status = 'archived'`: sync/apply.ts:85-87 pins `status`
 * monotonically at 'done', and applyMonotonic keys on FIELD NAME with no entity
 * scoping, so archiving a COMPLETED objective through sync would be silently
 * clamped back to 'done' — while an online PATCH (a raw UPDATE) would not be.
 * REST and sync would disagree. `archived_at` is orthogonal: an archived objective
 * keeps its status, so restore returns it intact.
 *
 * `archive_root_id` records the objective whose archiving cascaded to this row
 * (NULL on the root), so a subtree archives and restores as a unit. No FK: SQLite
 * cannot ALTER-ADD one (see 0086_objective_source_task), so the service scopes by
 * owner instead — the same tradeoff `source_task_id` made.
 *
 * All three are nullable with no DEFAULT: SQLite forbids a non-constant DEFAULT on
 * ADD COLUMN (see 0110_entity_tags_created_at), so NOT NULL DEFAULT CURRENT_TIMESTAMP
 * would force a table rebuild. Timestamps are written from code as ISO-8601
 * (`new Date().toISOString()`), never CURRENT_TIMESTAMP — the two formats do not
 * string-compare, and the purge job compares.
 *
 * Additive, idempotent (SQLite has no ADD COLUMN IF NOT EXISTS), forward-only.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'objectives', 'archived_at')) {
    db.exec(`ALTER TABLE objectives ADD COLUMN archived_at TEXT;`);
  }
  if (!hasColumn(db, 'objectives', 'archive_root_id')) {
    db.exec(`ALTER TABLE objectives ADD COLUMN archive_root_id TEXT;`);
  }
  if (!hasColumn(db, 'objectives', 'purge_after')) {
    db.exec(`ALTER TABLE objectives ADD COLUMN purge_after TEXT;`);
  }
  // The purge job's scan predicate. archived_at needs no index — buildTree already
  // scans by owner_id and the filter rides along.
  db.exec(`CREATE INDEX IF NOT EXISTS ix_objectives_purge_after ON objectives(purge_after);`);
}
