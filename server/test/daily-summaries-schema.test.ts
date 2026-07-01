import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0094 from '../src/db/migrations/0094_daily_summaries_owner_default.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');

type ColInfo = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
const summaryCols = (db: Database) =>
  db.prepare(`PRAGMA table_info(daily_summaries)`).all() as ColInfo[];

describe('0094 daily_summaries owner_id default fix', () => {
  it('rebuilds so owner_id is TEXT NOT NULL with NO default, preserving shape', () => {
    const db = fresh();
    runMigrations(db);

    const cols = summaryCols(db);

    // owner_id: TEXT, NOT NULL, and the bogus `DEFAULT 1` is gone.
    const ownerCol = cols.find((c) => c.name === 'owner_id');
    expect(ownerCol?.type.toUpperCase()).toBe('TEXT');
    expect(ownerCol?.notnull).toBe(1);
    expect(ownerCol?.dflt_value).toBeNull();

    // Composite PK is (owner_id, date), in that order.
    const pkOrder = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkOrder).toEqual(['owner_id', 'date']);

    // Column set AND physical order preserved from 0001 (0002's focus add was a
    // no-op — focus is already in the baseline) — a rebuild must not reorder.
    expect(cols.map((c) => c.name)).toEqual([
      'owner_id',
      'date',
      'prose',
      'stats',
      'focus',
      'llm',
      'inputs_hash',
      'created_at',
      'updated_at',
    ]);

    db.close();
  });

  it('an insert that omits owner_id now fails loudly (no default fallback)', () => {
    const db = fresh();
    runMigrations(db);

    // A valid insert with an explicit owner succeeds.
    expect(() =>
      db
        .prepare(
          `INSERT INTO daily_summaries (owner_id, date, prose, stats, inputs_hash) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(SYSTEM_OWNER_ID, '2026-07-01', 'prose', '{}', 'hash-a'),
    ).not.toThrow();

    // Omitting owner_id must throw a NOT NULL error — distinctively proving the
    // default is gone. (Pre-fix, `DEFAULT 1` filled owner_id so the row failed
    // LATER on a FOREIGN KEY error — owner `1` doesn't exist — meaning a bare
    // .toThrow() would pass even against the buggy schema. Matching /NOT NULL/
    // fails red on the buggy shape, so this assertion actually guards the fix.)
    expect(() =>
      db
        .prepare(
          `INSERT INTO daily_summaries (date, prose, stats, inputs_hash) VALUES (?, ?, ?, ?)`,
        )
        .run('2026-07-02', 'prose', '{}', 'hash-b'),
    ).toThrow(/NOT NULL/i);

    // No dangling FKs after the rebuild.
    expect(db.pragma('foreign_key_check')).toEqual([]);

    db.close();
  });

  it('is idempotent — the runner skips it AND its own up() guard no-ops on re-run', () => {
    const db = fresh();
    runMigrations(db);

    // (a) the runner's bookkeeping skips an already-recorded migration.
    const { applied } = runMigrations(db);
    expect(applied).toEqual([]);

    // (b) the migration's OWN re-run guard: invoking up() directly against the
    // already-fixed table must be a clean no-op (not attempt a second rebuild).
    // The runner never re-enters up() on its own, so this is the only thing that
    // exercises the `dflt_value == null && notnull && TEXT` early-return guard.
    const before = summaryCols(db).map((c) => c.name);
    expect(() => m0094.up(db)).not.toThrow();
    expect(summaryCols(db).map((c) => c.name)).toEqual(before); // no leftover _new table / no reshape

    const ownerCol = summaryCols(db).find((c) => c.name === 'owner_id');
    expect(ownerCol?.notnull).toBe(1);
    expect(ownerCol?.dflt_value).toBeNull();

    db.close();
  });
});
