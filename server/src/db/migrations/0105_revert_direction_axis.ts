import type { Database } from 'better-sqlite3';

export const id = '0105_revert_direction_axis';
// Rebuilds tag_prefs (its 0097 CHECK constraint hard-codes the old kind value) —
// toggles foreign_keys OFF for the swap, so it runs outside the runner's
// auto-transaction. CON-1.
export const manual = true;

/**
 * Phase Z / W2 — revert the tag GROUPING axis from `kind='pattern'` back to
 * `kind='direction'`, undoing migrations 0038 (value) and 0043 (table/column) at
 * the LIVE-schema level. The frozen historical migrations are NEVER edited; this
 * new forward migration reverses their effect.
 *
 * Why revert: "pattern" was overloaded across three unrelated concepts. The
 * top-level grouping tags (Work / Life / Home) are **directions** (the original
 * 0036 vocabulary); 0038/0043 mis-renamed them to "pattern", stealing the word
 * from the *day-arrangement* concept (`pattern_blocks`, which KEEPS the name) and
 * colliding with the Routine placement marker `time_blocks.source_kind='pattern'`.
 * After this, "pattern" survives only on `pattern_blocks` = one clean meaning.
 *
 * Changes (all LIVE-schema, guarded, atomic under one FK-off transaction):
 *   1. tags.kind         'pattern' → 'direction'   (no CHECK on tags — plain UPDATE)
 *   2. tag_prefs         rebuild with CHECK(kind IN ('direction','category')) and
 *                        translate kind 'pattern' → 'direction' in the copy.
 *                        ⚠ A bare UPDATE would VIOLATE the 0097 CHECK
 *                        (kind IN ('pattern','category')) — hence the rebuild.
 *   3. tag_patterns      → tag_directions  (+ column pattern_tag_id → direction_tag_id)
 *   4. pattern_blocks    column pattern_tag_id → direction_tag_id  (TABLE NAME KEPT —
 *                        it is the day-arrangement "Pattern", a different concept)
 *   5. category_direction_optouts  column pattern_tag_id → direction_tag_id
 *                        (table name already says 'direction')
 *   6. index idx_tag_patterns_pattern → idx_tag_directions_direction
 *
 * Idempotent: guards on the post-rename table name (`tag_directions`). SQLite 3.26+
 * ALTER TABLE RENAME auto-updates FK references (legacy_alter_table OFF = default);
 * a PRAGMA foreign_key_check runs at the end. Both tag_prefs and tag_directions are
 * leaf-ish / FK targets whose references SQLite rewrites on rename.
 */
export function up(db: Database): void {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((r) => r.name);
  if (tables.includes('tag_directions')) return; // already applied

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      // 1. tags grouping value (no CHECK — safe plain UPDATE)
      db.exec(`UPDATE tags SET kind = 'direction' WHERE kind = 'pattern'`);

      // 2. tag_prefs: rebuild with the reverted CHECK, translating the kind value.
      //    Mirrors the 0097 DDL exactly except CHECK + the CASE-translated copy.
      db.exec(`
        CREATE TABLE tag_prefs_new (
          id               TEXT PRIMARY KEY,
          owner_id         TEXT NOT NULL REFERENCES owners(id),
          tag_id           TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          kind             TEXT NOT NULL CHECK (kind IN ('direction','category')),
          auto_fill        INTEGER,              -- direction-only; NULL for category rows
          reminder_offsets TEXT,                 -- direction-only; NULL for category rows
          icon_shape       TEXT,                 -- direction-only; NULL for category rows
          color_token      TEXT NOT NULL DEFAULT 'primary',
          default_minutes  INTEGER NOT NULL DEFAULT 60,
          UNIQUE (owner_id, tag_id)
        );
        INSERT INTO tag_prefs_new (id, owner_id, tag_id, kind, auto_fill, reminder_offsets, icon_shape, color_token, default_minutes)
          SELECT id, owner_id, tag_id,
                 CASE WHEN kind = 'pattern' THEN 'direction' ELSE kind END,
                 auto_fill, reminder_offsets, icon_shape, color_token, default_minutes
            FROM tag_prefs;
        DROP TABLE tag_prefs;
        ALTER TABLE tag_prefs_new RENAME TO tag_prefs;
        CREATE INDEX ix_tag_prefs_owner ON tag_prefs(owner_id);
      `);

      // 3. tag_patterns → tag_directions (+ column). Reverses 0043.
      db.exec(`ALTER TABLE tag_patterns RENAME TO tag_directions`);
      db.exec(`ALTER TABLE tag_directions RENAME COLUMN pattern_tag_id TO direction_tag_id`);

      // 4. pattern_blocks: KEEP the table name; rename only the FK column.
      const pbCols = (db.prepare(`PRAGMA table_info(pattern_blocks)`).all() as { name: string }[]).map((c) => c.name);
      if (pbCols.includes('pattern_tag_id')) {
        db.exec(`ALTER TABLE pattern_blocks RENAME COLUMN pattern_tag_id TO direction_tag_id`);
      }

      // 5. category_direction_optouts: table name already 'direction'; fix the column.
      const cdoCols = (db.prepare(`PRAGMA table_info(category_direction_optouts)`).all() as { name: string }[]).map((c) => c.name);
      if (cdoCols.includes('pattern_tag_id')) {
        db.exec(`ALTER TABLE category_direction_optouts RENAME COLUMN pattern_tag_id TO direction_tag_id`);
      }

      // 6. index name coherence (reverses 0043's idx_tag_patterns_pattern).
      db.exec(`DROP INDEX IF EXISTS idx_tag_patterns_pattern`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tag_directions_direction ON tag_directions(direction_tag_id)`);
    });
    tx();

    const fk = db.prepare(`PRAGMA foreign_key_check`).all();
    if (fk.length > 0) {
      throw new Error(`0105_revert_direction_axis: foreign_key_check found ${fk.length} violation(s): ${JSON.stringify(fk)}`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
