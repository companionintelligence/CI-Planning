import type { Database } from 'better-sqlite3';

export const id = '0097_tag_prefs';
// Merges two tables into one (create + backfill + drop) — toggles foreign_keys
// OFF for the swap, so it runs outside the runner's auto-transaction. CON-1.
export const manual = true;

/**
 * S2 (schema consolidation) — merge `pattern_prefs` + `category_prefs` into one
 * `tag_prefs` table, distinguished by a `kind` column. `category_prefs` was a
 * documented "trimmed mirror" of `pattern_prefs` (same (owner, tag) grain, same
 * fetch-merge-upsert shape, both FK -> tags(id) ON DELETE CASCADE); it just
 * dropped the pattern-only columns (auto_fill / reminder_offsets / icon_shape).
 *
 * In `tag_prefs` those three pattern-only columns are NULLABLE (category rows
 * carry NULL); the shared color_token/default_minutes stay NOT NULL DEFAULT.
 * `kind` is denormalized from tags.kind so the two service modules can filter
 * without a join. UNIQUE(owner_id, tag_id) is sufficient (a tag has exactly one
 * kind, so a tag_id never appears on both axes).
 *
 * Both sources are LEAF tables (nothing FK-references them), so the drop is safe;
 * FK is toggled OFF only as the standard rebuild posture. Forward-only + idempotent
 * (guards on `tag_prefs` already existing). No HTTP contract changes: the two
 * services/routes still expose their own shapes over this one table.
 */
export function up(db: Database): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tag_prefs'`)
    .get();
  if (exists) return; // already merged — re-run safety.

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE tag_prefs (
          id               TEXT PRIMARY KEY,
          owner_id         TEXT NOT NULL REFERENCES owners(id),
          tag_id           TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          kind             TEXT NOT NULL CHECK (kind IN ('pattern','category')),
          auto_fill        INTEGER,              -- pattern-only; NULL for category rows
          reminder_offsets TEXT,                 -- pattern-only; NULL for category rows
          icon_shape       TEXT,                 -- pattern-only; NULL for category rows
          color_token      TEXT NOT NULL DEFAULT 'primary',
          default_minutes  INTEGER NOT NULL DEFAULT 60,
          UNIQUE (owner_id, tag_id)
        );
        CREATE INDEX ix_tag_prefs_owner ON tag_prefs(owner_id);

        INSERT INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill, reminder_offsets, icon_shape, color_token, default_minutes)
          SELECT id, owner_id, pattern_tag_id, 'pattern', auto_fill, reminder_offsets, icon_shape, color_token, default_minutes
            FROM pattern_prefs;
        INSERT INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill, reminder_offsets, icon_shape, color_token, default_minutes)
          SELECT id, owner_id, category_tag_id, 'category', NULL, NULL, NULL, color_token, default_minutes
            FROM category_prefs;

        DROP TABLE pattern_prefs;
        DROP TABLE category_prefs;
      `);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
