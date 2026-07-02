import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { sqlite } from '../src/db/index.js';
import { tagPrefs } from '../src/db/schema.js';

/**
 * Guards against Drizzle-vs-migration column drift. `pattern_prefs.default_minutes`
 * (migration 0040) was present in the DB and used via raw SQL, but missing from the
 * Drizzle table object — invisible to anyone querying the table through the ORM.
 * Asserting full column parity catches this and any future drift. Since 0097 the
 * pattern + category prefs live in one `tag_prefs` table, so that's what we guard.
 */
describe('Drizzle ↔ DB schema parity', () => {
  it('tag_prefs Drizzle columns cover every DB column', () => {
    const dbCols = (sqlite.prepare(`PRAGMA table_info(tag_prefs)`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    const drizzleCols = Object.values(getTableColumns(tagPrefs))
      .map((c) => c.name)
      .sort();
    expect(drizzleCols).toEqual(dbCols);
  });
});
