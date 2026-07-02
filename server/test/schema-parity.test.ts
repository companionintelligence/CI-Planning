import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { sqlite } from '../src/db/index.js';
import { tagPrefs, timeBlocks, tags } from '../src/db/schema.js';

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

  // T1 (multi-tenant): time_blocks gained owner_id via migration 0099. Guard the whole
  // column set so the Drizzle `ownerId` field and the migration's physical rebuild can
  // never drift (the rebuild reproduces 31 legacy columns + owner_id = 32).
  it('time_blocks Drizzle columns cover every DB column', () => {
    const dbCols = (sqlite.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    const drizzleCols = Object.values(getTableColumns(timeBlocks))
      .map((c) => c.name)
      .sort();
    expect(drizzleCols).toEqual(dbCols);
  });

  // T2 (multi-tenant): tags gained owner_id via migration 0100 (and UNIQUE(owner_id, name)
  // replaced the global UNIQUE(name)). Guard the column set so the Drizzle `ownerId` field
  // and the migration's rebuild can never drift.
  it('tags Drizzle columns cover every DB column', () => {
    const dbCols = (sqlite.prepare(`PRAGMA table_info(tags)`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    const drizzleCols = Object.values(getTableColumns(tags))
      .map((c) => c.name)
      .sort();
    expect(drizzleCols).toEqual(dbCols);
  });
});
