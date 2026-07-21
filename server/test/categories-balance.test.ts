import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';
import { setEntityCategories, entityCategoryNames, categoryIdsForOwner } from '../src/services/tags.js';

/**
 * 0134 — Categories ⇄ Balance unification. The category axis is re-seeded to the six
 * Balance Core Dimensions (health/career/relationships/growth/leisure/finance); the old
 * personal/professional/social set is gone; entity_categories carries 1–3 per entity.
 *
 * The SEED is verified on a FRESH in-memory DB (the shared file DB's resetDb wipes all
 * tags without re-seeding, so the migrated base categories only exist pre-reset). The
 * entity_categories SERVICE is verified on the shared DB with locally-created categories.
 */

const DIMS = ['health', 'career', 'relationships', 'growth', 'leisure', 'finance'];

describe('0134 seed (fresh DB) — categories match Balance dimensions', () => {
  it('seeds exactly the six Balance dimensions as base categories with tag-hue prefs', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);
    for (const name of DIMS) {
      const cat = db.prepare(`SELECT id, is_base FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`)
        .get(SYSTEM_OWNER_ID, name) as { id: string; is_base: number } | undefined;
      expect(cat, `category '${name}' exists`).toBeTruthy();
      expect(cat!.is_base).toBe(1);
      const pref = db.prepare(`SELECT color_token FROM tag_prefs WHERE owner_id = ? AND tag_id = ? AND kind = 'category'`)
        .get(SYSTEM_OWNER_ID, cat!.id) as { color_token: string } | undefined;
      expect(pref?.color_token).toMatch(/^tag-\d+$/);
    }
    // Exactly six category tags — nothing extra, nothing removed.
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM tags WHERE owner_id = ? AND kind = 'category'`)
      .get(SYSTEM_OWNER_ID) as { n: number }).n;
    expect(n).toBe(6);
    db.close();
  });

  it('removed the old block categories (personal/professional/social/family/me)', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);
    for (const gone of ['personal', 'professional', 'social', 'family', 'me']) {
      const row = db.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`)
        .get(SYSTEM_OWNER_ID, gone);
      expect(row, `old category '${gone}' is gone`).toBeUndefined();
    }
    db.close();
  });

  it('adds entity_categories with the position column', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);
    const cols = (db.prepare(`PRAGMA table_info(entity_categories)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['entity_kind', 'entity_id', 'category_tag_id', 'position']));
    db.close();
  });
});

describe('entity_categories service — 1–3 per task/time_block', () => {
  // resetDb wipes tags; create the categories this test needs.
  function seedCats(names: string[]): void {
    const insTag = sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (?, ?, ?, 'category', 1)`);
    const insPref = sqlite.prepare(`INSERT INTO tag_prefs (id, owner_id, tag_id, kind, color_token, default_minutes) VALUES (?, ?, ?, 'category', 'tag-1', 60)`);
    for (const n of names) { const id = newId(); insTag.run(id, SYSTEM_OWNER, n); insPref.run(newId(), SYSTEM_OWNER, id); }
  }
  beforeEach(() => { resetDb(); seedCats(DIMS); });

  it('replaces the set, caps at 3, preserves order', () => {
    const taskId = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'T', ?, 'open') RETURNING id`)
      .get(SYSTEM_OWNER) as { id: string }).id;
    setEntityCategories('task', taskId, categoryIdsForOwner(['finance', 'health', 'career', 'leisure'], SYSTEM_OWNER));
    expect(entityCategoryNames('task', taskId)).toEqual(['finance', 'health', 'career']); // 4th dropped, order kept

    setEntityCategories('task', taskId, categoryIdsForOwner(['growth'], SYSTEM_OWNER));
    expect(entityCategoryNames('task', taskId)).toEqual(['growth']); // replace, not append

    setEntityCategories('task', taskId, []);
    expect(entityCategoryNames('task', taskId)).toEqual([]); // clear
  });

  it('deduplicates and ignores unknown / foreign names', () => {
    const blockId = newId();
    setEntityCategories('time_block', blockId, categoryIdsForOwner(['health', 'health', 'nonsense', 'career'], SYSTEM_OWNER));
    expect(entityCategoryNames('time_block', blockId)).toEqual(['health', 'career']);
  });

  it('category resolution is owner-scoped', () => {
    sqlite.prepare(`INSERT INTO owners (id, name) VALUES ('owner-z', 'Z')`).run();
    expect(categoryIdsForOwner(['health'], 'owner-z')).toEqual([]); // owner-z has no categories
  });
});
