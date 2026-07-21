import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0134_categories_balance';

/**
 * Categories ⇄ Balance unification (owner ruling 2026-07-20). Retires the old Time
 * Block Categories (personal / professional / social + `family` + any custom) and
 * re-seeds the `kind='category'` axis to MATCH the Balance view's six Core Dimensions
 * (`life_priorities.category` keys), so a Category IS a tracked Balance dimension by
 * name. Add/remove of categories is gated behind a feature flag that ships OFF, so for
 * now these six are the fixed vocabulary (all `is_base=1`).
 *
 * Also adds `entity_categories` — the many-to-many store letting a task OR a time block
 * carry 1–3 categories (a second multi-select axis, like intentions), which the single
 * `time_blocks.category_id` column could not. `category_id` stays for back-compat reads
 * during the transition; new writes go through `entity_categories`.
 *
 * Colours map each dimension to the nearest CI-Hub tag hue (index.css `--tag-N`), so the
 * Planner/Balance tints line up with the Balance view's Tailwind swatches:
 *   health→tag-1(red) career→tag-7(blue) relationships→tag-11(pink)
 *   growth→tag-9(purple) leisure→tag-5(green) finance→tag-2(amber)
 *
 * Destructive by design (the ruling: "remove the existing block categories"): every
 * prior category tag + its prefs/memberships/opt-outs are deleted and any block pointing
 * at one has `category_id`/`color_token` nulled. Idempotent: the six are OR-IGNORE'd by
 * (owner, name), and a re-run finds the old set already gone.
 */

// [name, color_token, default_minutes] — names match life_priorities.category keys.
const DIMENSIONS: readonly (readonly [string, string, number])[] = [
  ['health', 'tag-1', 45],
  ['career', 'tag-7', 60],
  ['relationships', 'tag-11', 60],
  ['growth', 'tag-9', 45],
  ['leisure', 'tag-5', 60],
  ['finance', 'tag-2', 30],
];

export function up(db: Database): void {
  // ── entity_categories: 1–3 categories per task/time_block (position-ordered). ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_categories (
      entity_kind     TEXT NOT NULL,                 -- 'task' | 'time_block'
      entity_id       TEXT NOT NULL,                 -- PK of the entity (no FK — spans tables)
      category_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      position        INTEGER NOT NULL DEFAULT 0,     -- display order (0–2); drives stripe order
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_kind, entity_id, category_tag_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_entity_categories_entity ON entity_categories (entity_kind, entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_entity_categories_tag ON entity_categories (category_tag_id)`);

  const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];

  const nullBlocks = db.prepare(
    `UPDATE time_blocks SET category_id = NULL, color_token = NULL
      WHERE owner_id = ? AND category_id IN (SELECT id FROM tags WHERE owner_id = ? AND kind = 'category')`,
  );
  const delOptouts = db.prepare(
    `DELETE FROM category_direction_optouts WHERE category_tag_id IN (SELECT id FROM tags WHERE owner_id = ? AND kind = 'category')`,
  );
  const delTagCats = db.prepare(
    `DELETE FROM tag_categories WHERE category_tag_id IN (SELECT id FROM tags WHERE owner_id = ? AND kind = 'category')`,
  );
  const delEntityCats = db.prepare(
    `DELETE FROM entity_categories WHERE category_tag_id IN (SELECT id FROM tags WHERE owner_id = ? AND kind = 'category')`,
  );
  const delPrefs = db.prepare(`DELETE FROM tag_prefs WHERE owner_id = ? AND kind = 'category'`);
  const delTags = db.prepare(`DELETE FROM tags WHERE owner_id = ? AND kind = 'category'`);

  const byName = db.prepare(`SELECT id, kind FROM tags WHERE owner_id = ? AND name = ?`);
  const insTag = db.prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (?, ?, ?, 'category', 1)`);
  const insPref = db.prepare(
    `INSERT OR IGNORE INTO tag_prefs (id, owner_id, tag_id, kind, color_token, default_minutes)
     VALUES (?, ?, ?, 'category', ?, ?)`,
  );

  for (const o of owners) {
    // Detach + purge the old category axis for this owner.
    nullBlocks.run(o.id, o.id);
    delOptouts.run(o.id);
    delTagCats.run(o.id);
    delEntityCats.run(o.id);
    delPrefs.run(o.id);
    delTags.run(o.id);

    // Seed the six Balance-aligned base categories.
    for (const [name, color, minutes] of DIMENSIONS) {
      const existing = byName.get(o.id, name) as { id: string; kind: string } | undefined;
      if (existing) {
        // A non-category tag already owns this name → don't clobber; skip (the axes
        // are name-unique per owner, so the category simply won't seed for this owner).
        if (existing.kind !== 'category') continue;
        db.prepare(`UPDATE tags SET kind = 'category', is_base = 1 WHERE id = ?`).run(existing.id);
        insPref.run(newId(), o.id, existing.id, color, minutes);
      } else {
        const nid = newId();
        insTag.run(nid, o.id, name);
        insPref.run(newId(), o.id, nid, color, minutes);
      }
    }
  }
}
