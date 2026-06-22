import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0039_pattern_prefs';

/**
 * Create `pattern_prefs`: per-owner, per-pattern-tag preferences. Holds the
 * scheduling toggle (`auto_fill`), reminder offsets, AND the pattern-block display
 * config (`icon_shape` + `color_token`). The display config lives HERE — keyed by
 * the pattern (direction) tag — rather than on `pattern_types`, which stays
 * dedicated to the Habit/Routine/Ritual pattern taxonomy.
 *
 * Backfills a default row per existing owner × pattern tag. Base tags get their
 * canonical shape (home=circle, work=square, community=triangle); any other
 * pattern tag defaults to circle. Safe no-op on an empty DB. Additive + idempotent.
 */

// Default block shape per base pattern tag.
const BASE_SHAPES: Record<string, string> = {
  home: 'circle',
  work: 'square',
  community: 'triangle',
};

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_prefs (
      id               TEXT PRIMARY KEY,
      owner_id         TEXT NOT NULL REFERENCES owners(id),
      pattern_tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      auto_fill        INTEGER NOT NULL DEFAULT 1,
      reminder_offsets TEXT NOT NULL DEFAULT '[]',
      icon_shape       TEXT NOT NULL DEFAULT 'circle',
      color_token      TEXT NOT NULL DEFAULT 'primary',
      UNIQUE(owner_id, pattern_tag_id)
    );
    CREATE INDEX IF NOT EXISTS ix_pattern_prefs_owner ON pattern_prefs(owner_id);
  `);

  // Backfill: one default row per owner × pattern tag, with the base shape default.
  const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];
  const patternTags = db.prepare(`SELECT id, name FROM tags WHERE kind = 'pattern'`).all() as {
    id: string;
    name: string;
  }[];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO pattern_prefs
       (id, owner_id, pattern_tag_id, auto_fill, reminder_offsets, icon_shape, color_token)
     VALUES (?, ?, ?, 1, '[]', ?, 'primary')`,
  );

  for (const owner of owners) {
    for (const tag of patternTags) {
      ins.run(newId(), owner.id, tag.id, BASE_SHAPES[tag.name] ?? 'circle');
    }
  }
}
