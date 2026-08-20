import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { sqlite } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

/**
 * Golden-shape guard: every table modeled in `schema.ts` (the Drizzle ORM schema) must
 * have EXACTLY the columns the live DB has after all migrations run. The DB is built
 * purely from the migration files (db/index.ts → runMigrations); `schema.ts` is the
 * hand-maintained ORM mirror. When the two drift, the failure modes are silent and nasty:
 *
 *  - a column present in the DB but missing from Drizzle is invisible to ORM queries
 *    (the original `pattern_prefs.default_minutes` bug, migration 0040); and
 *  - a column present in Drizzle but missing from the DB throws `no such column` only at
 *    runtime on the first query that touches it (e.g. `oauth_states.scopes`, added by 0058
 *    and later dropped by 0061 — schema.ts correctly omits it; this test proves it).
 *
 * Iterating ALL exported Drizzle tables (not a hand-picked few) means any NEW table or
 * column that lands in a migration without its schema.ts mirror — or vice versa — turns a
 * silent drift into an explicit, per-table test failure. Column-NAME parity only (types /
 * constraints / indexes are out of scope); DB-only tables not modeled in schema.ts (e.g.
 * migration bookkeeping, sqlite internals) are intentionally not asserted here.
 */
// 0156 — workday_start/workday_end were removed from scheduling_prefs' schema.ts
// mirror (and every app read/write) but the column itself was deliberately left
// undropped: no destructive migration was bundled with the behavior change. That is
// an intentional, temporary drift this generic parity check would otherwise flag.
// Remove this exception in the same follow-up migration that finally drops the columns.
const STAGED_REMOVED_COLUMNS: Record<string, string[]> = {
  scheduling_prefs: ['workday_start', 'workday_end'],
};

describe('Drizzle ↔ DB schema parity (golden shape)', () => {
  // Every SQLiteTable exported from schema.ts (skips enums, view objects, helpers, types).
  const tables = Object.values(schema).filter((v): v is SQLiteTable => is(v, SQLiteTable));

  it('schema.ts exports a non-trivial set of tables (guards against the filter silently matching none)', () => {
    expect(tables.length).toBeGreaterThan(20);
  });

  for (const table of tables) {
    const name = getTableName(table);
    it(`${name} — Drizzle columns match the live DB exactly`, () => {
      const staged = new Set(STAGED_REMOVED_COLUMNS[name] ?? []);
      const dbCols = (sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[])
        .map((c) => c.name)
        .filter((n) => !staged.has(n))
        .sort();
      // A table modeled in schema.ts but absent from the DB yields an empty PRAGMA result —
      // the mismatch below then fails loudly (rather than a confusing pass).
      expect(dbCols, `table '${name}' is modeled in schema.ts but has no columns in the DB`).not.toEqual([]);
      const drizzleCols = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();
      expect(drizzleCols).toEqual(dbCols);
    });
  }
});
