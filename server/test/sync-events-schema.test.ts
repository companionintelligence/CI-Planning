import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0098 from '../src/db/migrations/0098_sync_events_owner_fk.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');

type ColInfo = { name: string; notnull: number; pk: number };
const syncEventsCols = (db: Database) =>
  db.prepare(`PRAGMA table_info(sync_events)`).all() as ColInfo[];

// A fresh migrated DB has no rows and no non-SYSTEM owner; seed a valid event.
const insertEvent = (db: Database, ownerId: string) =>
  db
    .prepare(
      `INSERT INTO sync_events (owner_id, event, payload, at)
       VALUES (?, 'task:update', '{}', '2026-07-02T00:00:00Z')`,
    )
    .run(ownerId);

describe('0098 sync_events.owner_id FK', () => {
  it('rebuilds sync_events preserving every column, order, and the seq PK', () => {
    const db = fresh();
    runMigrations(db);

    const cols = syncEventsCols(db);

    // Exact column set AND physical order preserved from 0077 — the rebuild must
    // change ONLY the owner_id FK, never reorder or drop a column.
    expect(cols.map((c) => c.name)).toEqual([
      'seq',
      'owner_id',
      'entity',
      'entity_id',
      'version',
      'event',
      'payload',
      'at',
    ]);

    // seq stays the single-column primary key.
    const pkOrder = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkOrder).toEqual(['seq']);

    // owner_id keeps its NOT NULL.
    expect(cols.find((c) => c.name === 'owner_id')?.notnull).toBe(1);

    // owner_id is now an enforced FK to owners(id) — the fix.
    const fk = (
      db.prepare(`PRAGMA foreign_key_list(sync_events)`).all() as {
        table: string;
        from: string;
        to: string;
      }[]
    ).find((f) => f.from === 'owner_id');
    expect(fk).toMatchObject({ table: 'owners', to: 'id' });

    // The 0077 index survives the rebuild.
    const indexes = db
      .prepare(`PRAGMA index_list(sync_events)`)
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('sync_events_owner_seq');

    db.close();
  });

  it('rejects a non-existent owner_id and accepts a valid one', () => {
    const db = fresh();
    runMigrations(db);
    // SQLite defaults FK enforcement OFF; enable `foreign_keys` explicitly for this in-memory DB.
    db.pragma('foreign_keys = ON');

    // (a) inserting with an owner_id that names no owner now fails with an FK error.
    expect(() =>
      insertEvent(db, '00000000-0000-7000-8000-0000000000ff'),
    ).toThrow(/FOREIGN KEY/i);

    // (b) a valid insert against the seeded SYSTEM owner succeeds.
    expect(() => insertEvent(db, SYSTEM_OWNER_ID)).not.toThrow();

    db.close();
  });

  it('leaves the schema sound with zero orphan owner_id, and is idempotent', () => {
    const db = fresh();
    runMigrations(db);

    // (c) post-migration integrity: no dangling FKs, no orphan owner_id rows.
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sync_events
         WHERE owner_id NOT IN (SELECT id FROM owners)`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);

    // (d) idempotent: the runner skips it, and up()'s own foreign_key_list guard
    // no-ops on re-run (a second rebuild would fail on a leftover *_new table).
    expect(runMigrations(db).applied).toEqual([]);
    const before = syncEventsCols(db).map((c) => c.name);
    expect(() => m0098.up(db)).not.toThrow();
    expect(syncEventsCols(db).map((c) => c.name)).toEqual(before);

    db.close();
  });
});
