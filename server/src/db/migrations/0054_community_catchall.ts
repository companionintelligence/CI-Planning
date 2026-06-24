import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0054_community_catchall';

/**
 * Adds `catch_all` to `pattern_types` and seeds a Community built-in type
 * with catch_all=1. A catch-all Plan accepts every staged task regardless of
 * tag, ordered by priority only — intended for shared/community activities
 * where any work domain is appropriate.
 *
 * Idempotent: PRAGMA check guards the ALTER TABLE; INSERT OR IGNORE + UPDATE
 * handle pre-existing Community rows. Additive.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(pattern_types)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes('catch_all')) {
    db.prepare(`ALTER TABLE pattern_types ADD COLUMN catch_all INTEGER NOT NULL DEFAULT 0`).run();
  }

  // Seed one Community pattern type per owner (idempotent via the unique index).
  const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO pattern_types (id, owner_id, name, icon_shape, is_builtin, catch_all)
     VALUES (?, ?, 'Community', 'users', 1, 1)`,
  );
  for (const owner of owners) ins.run(newId(), owner.id);

  // In case Community already existed (user-created), mark it catch-all.
  db.prepare(`UPDATE pattern_types SET catch_all = 1 WHERE name = 'Community'`).run();
}
