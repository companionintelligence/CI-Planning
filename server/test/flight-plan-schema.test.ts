import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0093 from '../src/db/migrations/0093_flight_plan_notnull.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');

// A fixed UUIDv7-shaped task id (this in-memory DB has no uuid7() UDF, so ids
// are supplied literally, matching migrate.test.ts).
const TASK_ID = '00000000-0000-7000-8000-0000000000d1';

type ColInfo = { name: string; notnull: number; pk: number };
const flightPlanCols = (db: Database) =>
  db.prepare(`PRAGMA table_info(flight_plan)`).all() as ColInfo[];

describe('0093 flight_plan owner_id NOT NULL', () => {
  it('rebuilds flight_plan so owner_id is TEXT NOT NULL with the (owner_id, task_id) PK', () => {
    const db = fresh();
    runMigrations(db);

    const cols = flightPlanCols(db);

    // owner_id is NOT NULL (the fix).
    const ownerCol = cols.find((c) => c.name === 'owner_id');
    expect(ownerCol?.notnull).toBe(1);

    // source_kind's NOT NULL (from 0081) is PRESERVED by the rebuild — the rebuild
    // must be faithful, changing only owner_id.
    const sourceKindCol = cols.find((c) => c.name === 'source_kind');
    expect(sourceKindCol?.notnull).toBe(1);

    // Composite PK is (owner_id, task_id), in that order (pk field carries the
    // 1-based position within the PK; non-PK columns are 0).
    const pkOrder = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkOrder).toEqual(['owner_id', 'task_id']);

    // Exact column set AND physical order preserved from the live table
    // (0016 base + 0081-appended source_kind/source_ref) — a rebuild must not
    // gratuitously reorder columns.
    expect(cols.map((c) => c.name)).toEqual([
      'owner_id',
      'task_id',
      'selected',
      'position',
      'added_at',
      'source_kind',
      'source_ref',
    ]);

    db.close();
  });

  it('enforces NOT NULL owner_id and the composite PK on insert', () => {
    const db = fresh();
    runMigrations(db);

    // Seed a task the flight_plan rows can reference (FK on task_id).
    db.prepare(
      `INSERT INTO tasks (id, title, status, owner_id) VALUES (?, 'T', 'open', ?)`,
    ).run(TASK_ID, SYSTEM_OWNER_ID);

    // A valid insert succeeds.
    expect(() =>
      db
        .prepare(`INSERT INTO flight_plan (owner_id, task_id) VALUES (?, ?)`)
        .run(SYSTEM_OWNER_ID, TASK_ID),
    ).not.toThrow();

    // NULL owner_id is rejected (NOT NULL enforced).
    expect(() =>
      db
        .prepare(`INSERT INTO flight_plan (owner_id, task_id) VALUES (?, ?)`)
        .run(null, TASK_ID),
    ).toThrow();

    // Duplicate composite PK is rejected.
    expect(() =>
      db
        .prepare(`INSERT INTO flight_plan (owner_id, task_id) VALUES (?, ?)`)
        .run(SYSTEM_OWNER_ID, TASK_ID),
    ).toThrow();

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
    // already-rebuilt table must be a clean no-op — NOT attempt a second rebuild
    // (which would fail on a leftover flight_plan_new). The runner never re-enters
    // up() on its own, so this is the only thing that exercises the
    // `owner_id.notnull === 1` early-return guard.
    const before = flightPlanCols(db).map((c) => c.name);
    expect(() => m0093.up(db)).not.toThrow();
    expect(flightPlanCols(db).map((c) => c.name)).toEqual(before);

    const ownerCol = flightPlanCols(db).find((c) => c.name === 'owner_id');
    expect(ownerCol?.notnull).toBe(1);

    db.close();
  });
});
