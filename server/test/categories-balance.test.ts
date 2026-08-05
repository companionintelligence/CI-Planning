import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';
import {
  setEntityCategories, entityCategoryNames, categoryIdsForOwner,
  entityCategoryNamesByIds, removeEntityTags,
} from '../src/services/tags.js';
import { createTask, updateTask, recallTask } from '../src/services/tasks.js';
import { createBlock, updateBlock, blockCategoryNames } from '../src/services/blocks.js';

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

  it('replaces the set, caps at 3, preserves order', async () => {
    const taskId = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'T', ?, 'open') RETURNING id`)
      .get(SYSTEM_OWNER) as { id: string }).id;
    await setEntityCategories('task', taskId, await categoryIdsForOwner(['finance', 'health', 'career', 'leisure'], SYSTEM_OWNER));
    expect(await entityCategoryNames('task', taskId)).toEqual(['finance', 'health', 'career']); // 4th dropped, order kept

    await setEntityCategories('task', taskId, await categoryIdsForOwner(['growth'], SYSTEM_OWNER));
    expect(await entityCategoryNames('task', taskId)).toEqual(['growth']); // replace, not append

    await setEntityCategories('task', taskId, []);
    expect(await entityCategoryNames('task', taskId)).toEqual([]); // clear
  });

  it('deduplicates and ignores unknown / foreign names', async () => {
    const blockId = newId();
    await setEntityCategories('time_block', blockId, await categoryIdsForOwner(['health', 'health', 'nonsense', 'career'], SYSTEM_OWNER));
    expect(await entityCategoryNames('time_block', blockId)).toEqual(['health', 'career']);
  });

  it('category resolution is owner-scoped', async () => {
    sqlite.prepare(`INSERT INTO owners (id, name) VALUES ('owner-z', 'Z')`).run();
    expect(await categoryIdsForOwner(['health'], 'owner-z')).toEqual([]); // owner-z has no categories
  });

  it('batched reader returns every requested id (empty array when none)', async () => {
    const a = newId(), b = newId();
    await setEntityCategories('task', a, await categoryIdsForOwner(['career', 'health'], SYSTEM_OWNER));
    const map = await entityCategoryNamesByIds('task', [a, b]);
    expect(map.get(a)).toEqual(['career', 'health']);
    expect(map.get(b)).toEqual([]);
  });
});

describe('Phase B capture — service write/read wiring', () => {
  function seedCats(names: string[]): void {
    const insTag = sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (?, ?, ?, 'category', 1)`);
    const insPref = sqlite.prepare(`INSERT INTO tag_prefs (id, owner_id, tag_id, kind, color_token, default_minutes) VALUES (?, ?, ?, 'category', 'tag-1', 60)`);
    for (const n of names) { const id = newId(); insTag.run(id, SYSTEM_OWNER, n); insPref.run(newId(), SYSTEM_OWNER, id); }
  }
  beforeEach(() => { resetDb(); seedCats(DIMS); });

  it('createTask/updateTask round-trip: names in → position-ordered names out; undefined preserves; [] clears', async () => {
    const res = await createTask(SYSTEM_OWNER, { title: 'T', categories: ['finance', 'health'] });
    if (!res.ok) throw new Error('create failed');
    expect(await entityCategoryNames('task', res.task.id)).toEqual(['finance', 'health']);

    // A categories-less PATCH preserves the set.
    const up1 = await updateTask(SYSTEM_OWNER, res.task.id, { title: 'T2' });
    expect(up1.ok).toBe(true);
    expect(await entityCategoryNames('task', res.task.id)).toEqual(['finance', 'health']);

    // [] clears.
    const up2 = await updateTask(SYSTEM_OWNER, res.task.id, { categories: [] });
    expect(up2.ok).toBe(true);
    expect(await entityCategoryNames('task', res.task.id)).toEqual([]);
  });

  it('texture override columns ride create/update and default to enabled', async () => {
    const res = await createTask(SYSTEM_OWNER, { title: 'Tex' });
    if (!res.ok) throw new Error('create failed');
    expect(res.task.textureEnabled).toBe(true); // 0135 DEFAULT 1
    expect(res.task.textureColorToken).toBeNull();

    const up = await updateTask(SYSTEM_OWNER, res.task.id, { texture_enabled: false, texture_color_token: 'tag-5' });
    if (!up.ok) throw new Error('update failed');
    expect(up.task.textureEnabled).toBe(false);
    expect(up.task.textureColorToken).toBe('tag-5');
  });

  it('block create with categories: entity_categories written, retired category_id NOT, colour frozen from first', async () => {
    const res = await createBlock(SYSTEM_OWNER, {
      title: 'B', block_kind: 'timeblock', categories: ['career', 'growth'],
      start_at: '2026-06-20T09:00:00.000Z', end_at: '2026-06-20T10:00:00.000Z',
    });
    if (!res.ok) throw new Error('create failed');
    expect(res.block.categoryId).toBeNull();
    expect(res.block.colorToken).toBe('tag-1'); // frozen from career's pref
    expect((res.api as { categories: string[] }).categories).toEqual(['career', 'growth']);
  });

  it('task-backed block DERIVES its task categories (own rows win when present)', async () => {
    const t = await createTask(SYSTEM_OWNER, { title: 'T', categories: ['health'] });
    if (!t.ok) throw new Error('create failed');
    const b = await createBlock(SYSTEM_OWNER, {
      title: 'placed', task_id: t.task.id,
      start_at: '2026-06-20T09:00:00.000Z', end_at: '2026-06-20T10:00:00.000Z',
    });
    if (!b.ok) throw new Error('block failed');
    // No own rows → inherits the task's LIVE categories.
    expect(await blockCategoryNames(b.block.id, t.task.id)).toEqual(['health']);
    // Re-categorizing the task re-derives with zero block writes.
    await updateTask(SYSTEM_OWNER, t.task.id, { categories: ['leisure', 'health'] });
    expect(await blockCategoryNames(b.block.id, t.task.id)).toEqual(['leisure', 'health']);
    // Own rows win once set.
    const up = await updateBlock(SYSTEM_OWNER, b.block.id, { categories: ['finance'] });
    expect(up.ok).toBe(true);
    expect(await blockCategoryNames(b.block.id, t.task.id)).toEqual(['finance']);
  });

  it('recallTask clone carries categories (position preserved) + texture override', async () => {
    const t = await createTask(SYSTEM_OWNER, { title: 'Src', categories: ['growth', 'career'], texture_color_token: 'tag-9' });
    if (!t.ok) throw new Error('create failed');
    const cloned = await recallTask(SYSTEM_OWNER, t.task.id);
    if (!cloned.ok) throw new Error('recall failed');
    expect(await entityCategoryNames('task', cloned.task.id)).toEqual(['growth', 'career']);
    expect(cloned.task.textureColorToken).toBe('tag-9');
  });

  it('removeEntityTags purges entity_categories through the same seam (no orphans on hard delete)', async () => {
    const blockId = newId();
    await setEntityCategories('time_block', blockId, await categoryIdsForOwner(['health'], SYSTEM_OWNER));
    expect(await entityCategoryNames('time_block', blockId)).toEqual(['health']);
    await removeEntityTags('time_block', blockId);
    expect(await entityCategoryNames('time_block', blockId)).toEqual([]);
  });
});
