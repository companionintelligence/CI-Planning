import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { setCategoryPref, getCategoryPrefs } from '../src/services/category-prefs.js';
import { setPatternPref } from '../src/services/pattern-prefs.js';
import { resetDb } from './helpers.js';

/**
 * Defensive guard for the tag_prefs merge (0097): the two axes share one table +
 * UNIQUE(owner_id, tag_id). A tag's kind is immutable at runtime today, so a
 * mismatched-kind row shouldn't occur — but the upserts still normalize kind (and
 * NULL the pattern-only columns on the category path) so a pref row can never end
 * up stale/invisible to its axis's `kind` filter.
 */
describe('tag_prefs kind normalization on upsert', () => {
  beforeEach(() => resetDb()); // clears tags -> cascades tag_prefs

  const newTag = (kind: string) =>
    (sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
      .get(`t-${kind}`, kind, SYSTEM_OWNER) as { id: string }).id;
  const row = (tagId: string) =>
    sqlite.prepare(`SELECT * FROM tag_prefs WHERE owner_id=? AND tag_id=?`).get(SYSTEM_OWNER, tagId) as any;

  it('setCategoryPref rewrites a stale pattern-kind row to category and clears pattern-only cols', () => {
    const tag = newTag('category');
    // Simulate a stale pattern-axis row for this tag (can't happen normally).
    sqlite.prepare(
      `INSERT INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill, reminder_offsets, icon_shape, color_token, default_minutes)
       VALUES (uuid7(), ?, ?, 'pattern', 1, '[5,10]', 'square', 'chart-9', 30)`,
    ).run(SYSTEM_OWNER, tag);

    setCategoryPref(SYSTEM_OWNER, tag, { color_token: 'chart-1', default_minutes: 90 });

    const r = row(tag);
    expect(r.kind).toBe('category');
    expect(r.auto_fill).toBeNull();
    expect(r.reminder_offsets).toBeNull();
    expect(r.icon_shape).toBeNull();
    expect(r.color_token).toBe('chart-1');
    expect(r.default_minutes).toBe(90);
    // And it's now visible to the category reader.
    expect(getCategoryPrefs(SYSTEM_OWNER)[tag]).toEqual({ color_token: 'chart-1', default_minutes: 90 });
  });

  it('setPatternPref normalizes kind to pattern on conflict', () => {
    const tag = newTag('pattern');
    sqlite.prepare(
      `INSERT INTO tag_prefs (id, owner_id, tag_id, kind, color_token, default_minutes)
       VALUES (uuid7(), ?, ?, 'category', 'chart-3', 60)`,
    ).run(SYSTEM_OWNER, tag);

    setPatternPref(SYSTEM_OWNER, tag, { auto_fill: false });

    const r = row(tag);
    expect(r.kind).toBe('pattern');
    expect(r.auto_fill).toBe(0);
  });
});
