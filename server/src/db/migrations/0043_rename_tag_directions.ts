import type { Database } from 'better-sqlite3';

export const id = '0043_rename_tag_directions';

/**
 * Tag-axis de-collision (PR 1 of the pre-Phase-H cleanup).
 *
 * `tag_directions` is the junction table for the tag taxonomy axis
 * (intention-tag → pattern-tag membership). After migration 0038 ratified
 * `tags.kind = 'pattern'` as the canonical value for the top-level tag category,
 * the table name `tag_directions` and column `direction_tag_id` are stale — they
 * use the old vocabulary. Rename them to align with the ratified canon.
 *
 * Also renames `pattern_blocks.direction_tag_id` → `pattern_blocks.pattern_tag_id`
 * for the same reason (pattern_blocks.direction_tag_id was the FK into tag_directions).
 *
 * Idempotent: guards on the pre-rename table name; if `tag_patterns` already exists,
 * the migration is a no-op. The index is dropped by name and recreated so the name
 * stays coherent after the table rename.
 *
 * SQLite 3.26+ (bundled with better-sqlite3 ≥ 9) supports ALTER TABLE RENAME TO
 * (with FK-reference auto-update) and ALTER TABLE RENAME COLUMN.
 */
export function up(db: Database): void {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((r) => r.name);
  if (tables.includes('tag_patterns')) return; // already applied

  db.exec(`ALTER TABLE tag_directions RENAME TO tag_patterns`);
  db.exec(`ALTER TABLE tag_patterns RENAME COLUMN direction_tag_id TO pattern_tag_id`);

  const pbCols = (db.prepare(`PRAGMA table_info(pattern_blocks)`).all() as { name: string }[]).map((c) => c.name);
  if (pbCols.includes('direction_tag_id')) {
    db.exec(`ALTER TABLE pattern_blocks RENAME COLUMN direction_tag_id TO pattern_tag_id`);
  }

  db.exec(`DROP INDEX IF EXISTS idx_tag_directions_dir`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tag_patterns_pattern ON tag_patterns(pattern_tag_id)`);
}
