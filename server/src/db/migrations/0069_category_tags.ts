import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0069_category_tags';

/**
 * Time Block Categories (a third tags.kind value, 'category' — a Tag SUB-LEVEL, not a
 * new glossary noun). Bundles, in one migration (the 0037/0039 style):
 *   - `tag_categories`              — intention→category membership (mirror of tag_patterns)
 *   - `category_prefs`              — per-(owner × category) color + default_minutes (trimmed pattern_prefs)
 *   - `category_direction_optouts`  — sparse per-category direction opt-out (empty = all-on)
 *   - `time_blocks.category_id` + `time_blocks.color_token` — the forward-only category stamp
 *
 * Seeds three undeletable base categories (`family`/`social`/`me`, is_base=1) + a
 * default category_prefs row per owner × base category. Single-word names are
 * collision-free vs the 0036 seeds (`home`/`work`/`community` patterns;
 * `me-time`/`family-time`/`relax`/`socialize` intentions) under tags.name UNIQUE; the
 * seed FAILS LOUDLY rather than promote/clobber a pre-existing non-category tag.
 * Additive + idempotent (IF NOT EXISTS / column-existence guard / INSERT OR IGNORE).
 */

const BASE_CATEGORIES = ['family', 'social', 'me'] as const;
const BASE_COLORS: Record<string, string> = { family: 'chart-1', social: 'chart-3', me: 'chart-5' };

export function up(db: Database): void {
  // 1 — junctions + prefs + opt-out set + indexes (idempotent).
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_categories (
      intention_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      category_tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (intention_tag_id, category_tag_id)
    );
    CREATE INDEX IF NOT EXISTS ix_tag_categories_cat ON tag_categories(category_tag_id);
    CREATE TABLE IF NOT EXISTS category_prefs (
      id              TEXT PRIMARY KEY,
      owner_id        TEXT NOT NULL REFERENCES owners(id),
      category_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      color_token     TEXT NOT NULL DEFAULT 'primary',
      default_minutes INTEGER NOT NULL DEFAULT 60,
      UNIQUE(owner_id, category_tag_id)
    );
    CREATE INDEX IF NOT EXISTS ix_category_prefs_owner ON category_prefs(owner_id);
    CREATE TABLE IF NOT EXISTS category_direction_optouts (
      category_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      pattern_tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (category_tag_id, pattern_tag_id)
    );
  `);

  // 2 — time_blocks.category_id + color_token (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
  const tbCols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  if (!tbCols.includes('category_id')) db.exec(`ALTER TABLE time_blocks ADD COLUMN category_id TEXT REFERENCES tags(id) ON DELETE SET NULL`);
  if (!tbCols.includes('color_token')) db.exec(`ALTER TABLE time_blocks ADD COLUMN color_token TEXT`);

  // 3 — seed the three base categories; fail loudly on a collision with a non-category tag.
  const findByName = db.prepare(`SELECT id, kind FROM tags WHERE name = ?`);
  const insCat = db.prepare(`INSERT INTO tags (id, name, kind, is_base) VALUES (?, ?, 'category', 1)`);
  const catId: Record<string, string> = {};
  for (const name of BASE_CATEGORIES) {
    const existing = findByName.get(name) as { id: string; kind: string } | undefined;
    if (existing) {
      if (existing.kind !== 'category') {
        throw new Error(`0069: base category name '${name}' already exists as kind='${existing.kind}'; rename that tag before migrating.`);
      }
      catId[name] = existing.id; // re-run: already seeded
    } else {
      const nid = newId();
      insCat.run(nid, name);
      catId[name] = nid;
    }
  }

  // 4 — default category_prefs per owner × base category (distinct colors). No
  //     tag_categories rows: categories start empty/Unsorted, like un-patterned intentions.
  const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];
  const insPref = db.prepare(
    `INSERT OR IGNORE INTO category_prefs (id, owner_id, category_tag_id, color_token, default_minutes)
     VALUES (?, ?, ?, ?, 60)`,
  );
  for (const o of owners) {
    for (const name of BASE_CATEGORIES) insPref.run(newId(), o.id, catId[name], BASE_COLORS[name]);
  }
}
