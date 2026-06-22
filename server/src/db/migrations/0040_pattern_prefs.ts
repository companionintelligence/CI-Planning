import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0040_pattern_prefs';

/**
 * Create `pattern_prefs`: per-owner, per-pattern-tag preferences (auto_fill toggle,
 * reminder offsets). Backfills a default row for every existing owner × pattern tag
 * pair (kind='pattern'). Safe no-op on an empty DB.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_prefs (
      id               TEXT PRIMARY KEY,
      owner_id         TEXT NOT NULL REFERENCES owners(id),
      pattern_tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      auto_fill        INTEGER NOT NULL DEFAULT 1,
      reminder_offsets TEXT NOT NULL DEFAULT '[]',
      UNIQUE(owner_id, pattern_tag_id)
    );
    CREATE INDEX IF NOT EXISTS ix_pattern_prefs_owner ON pattern_prefs(owner_id);
  `);

  // Backfill: one default row per owner × pattern tag.
  const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];
  const patternTags = db.prepare(`SELECT id FROM tags WHERE kind = 'pattern'`).all() as {
    id: string;
  }[];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO pattern_prefs (id, owner_id, pattern_tag_id, auto_fill, reminder_offsets)
     VALUES (?, ?, ?, 1, '[]')`,
  );

  for (const owner of owners) {
    for (const tag of patternTags) {
      ins.run(newId(), owner.id, tag.id);
    }
  }
}
