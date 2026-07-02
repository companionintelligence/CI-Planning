import type { Database } from 'better-sqlite3';

export const id = '0100_tags_owner_id';
// Rebuild toggles foreign_keys OFF/ON (a no-op inside a transaction). CON-1.
export const manual = true;

/**
 * T2 (multi-tenant) — give the `tags` table an `owner_id` and relax the global name
 * uniqueness so each owner has their own tag namespace.
 *
 * `tags` was created in the 0001 baseline with `name TEXT NOT NULL UNIQUE` — a GLOBAL
 * uniqueness constraint (F-TAGUNIQUE). Under multi-tenant that's a blocker: a 2nd owner
 * can't reuse ANY tag name a 1st owner already took, and an import would collide. This
 * migration adds `owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE`, DROPS
 * the global `UNIQUE(name)`, and replaces it with `UNIQUE(owner_id, name)` — so two owners
 * can each hold a tag named "errands".
 *
 * SINGLE-PASS hand-written rebuild (like 0099): SQLite can't drop a UNIQUE constraint or
 * add a NOT NULL column in place, so we rebuild the table once. The backfill is inlined in
 * the copy's SELECT — every existing tag goes to the single owner (deterministically the
 * SYSTEM_OWNER sentinel, which sorts first among UUIDv7 ids). Because `name` was globally
 * unique, all names are distinct, so backfilling them all to one owner never violates the
 * new `UNIQUE(owner_id, name)`.
 *
 * INDEX NOTE: the `UNIQUE(owner_id, name)` constraint's auto-index leads with `owner_id`,
 * so it already serves owner-scoped reads (`WHERE owner_id = ?`) — a separate
 * `ix_tags_owner(owner_id)` would be strictly redundant, so we deliberately omit it.
 *
 * The 9 inbound tag_id FKs (entity_tags/tag_patterns/tag_categories/category_direction_optouts/
 * tag_prefs/possible_task_tags/pattern_blocks + time_blocks.category_id) all reference tags(id)
 * — the rebuild preserves every id verbatim, so they stay valid; a scoped
 * `PRAGMA foreign_key_check(tags)` gates the result (verifies tags' OWN owner_id FK).
 *
 * CASCADE (F-CASCADE): `owner_id` carries `ON DELETE CASCADE` per T1's precedent (a deleted
 * owner's tags — and the junctions that cascade off them — go with the owner). Owner-delete
 * cascade normalization across all tables is deferred to Phase U. Owners are never deleted
 * today, so the behavior is dormant.
 *
 * G-BASETAG (documented dependency, owned by T5/U): the base tags (home/work/community +
 * family/social/me, is_base=1) are seeded ONCE globally (0036/0069) and now all belong to
 * the single backfilled owner. A newly-provisioned 2nd owner gets ZERO base tags until
 * per-owner base-tag provisioning lands with owner creation (T5/U) — Auto silently places
 * nothing for them until then.
 *
 * Idempotent: guards on `owner_id` already existing on the table.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(tags)`).all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('owner_id')) return; // already migrated — re-run safety.

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      // New table: owner_id inserted at position 2 (after id); global UNIQUE(name) replaced
      // by UNIQUE(owner_id, name). Same types/defaults otherwise.
      db.exec(`
        CREATE TABLE tags_new (
          id       TEXT    PRIMARY KEY NOT NULL,
          owner_id TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
          name     TEXT    NOT NULL,
          kind     TEXT    NOT NULL DEFAULT 'intention',
          muted    INTEGER NOT NULL DEFAULT 0,
          is_base  INTEGER NOT NULL DEFAULT 0,
          UNIQUE (owner_id, name)
        );
      `);

      // Copy every tag, backfilling owner_id to the single owner (SYSTEM_OWNER sorts first).
      db.exec(`
        INSERT INTO tags_new (id, owner_id, name, kind, muted, is_base)
        SELECT id, (SELECT id FROM owners ORDER BY id LIMIT 1), name, kind, muted, is_base
        FROM tags;
      `);

      db.exec(`DROP TABLE tags;`);
      db.exec(`ALTER TABLE tags_new RENAME TO tags;`);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  // Fail loud on any orphan owner_id the rebuild would otherwise silently retain.
  const violations = db.prepare(`PRAGMA foreign_key_check(tags)`).all();
  if (violations.length > 0) {
    throw new Error(
      `0100_tags_owner_id: foreign_key_check found ${violations.length} violation(s) after rebuild; aborting.`,
    );
  }
}
