import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0039_pattern_block_config';

/**
 * Pattern-block config:
 * 1. Add `tag_id` column to `pattern_types` — links each built-in type to its
 *    base pattern tag (Home/circle, Work/square, Community/triangle).
 * 2. Wire up the three built-in rows to the matching base tags (looked up by
 *    name + kind='pattern' + is_base=1 after 0038 runs). Defensive: skips
 *    gracefully if the tag doesn't exist.
 * 3. Delink pattern collections from the old habit/routine/ritual type semantics:
 *    `UPDATE patterns SET type_id = NULL`.
 *
 * Additive + idempotent.
 */

// built-in pattern_types: name → base tag name (post-0038 these have kind='pattern')
const BUILTIN_LINKS: { typeName: string; tagName: string }[] = [
  { typeName: 'Habit',   tagName: 'home' },
  { typeName: 'Routine', tagName: 'work' },
  { typeName: 'Ritual',  tagName: 'community' },
];

export function up(db: Database): void {
  // 1. Add tag_id column to pattern_types (idempotent via PRAGMA check).
  const cols = (db.prepare(`PRAGMA table_info(pattern_types)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes('tag_id')) {
    db.exec(`ALTER TABLE pattern_types ADD COLUMN tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE`);
  }

  // 2. Link each built-in type row to its base pattern tag.
  const findTag = db.prepare(
    `SELECT id FROM tags WHERE name = ? AND kind = 'pattern' AND is_base = 1`,
  );
  const linkType = db.prepare(`UPDATE pattern_types SET tag_id = ? WHERE name = ? AND is_builtin = 1`);

  for (const { typeName, tagName } of BUILTIN_LINKS) {
    const tag = findTag.get(tagName) as { id: string } | undefined;
    if (!tag) continue; // defensive — tag absent on empty DB, skip gracefully
    linkType.run(tag.id, typeName);
  }

  // 3. Delink pattern collections from the old type semantics.
  db.exec(`UPDATE patterns SET type_id = NULL`);
}
