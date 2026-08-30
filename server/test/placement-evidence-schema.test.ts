import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0166 from '../src/db/migrations/0166_placement_evidence.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');
const tableExists = (db: Database, name: string) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const indexExists = (db: Database, name: string) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
const cols = (db: Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const pkCols = (db: Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
const count = (db: Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const insertLog = (db: Database, overrides: Partial<{ id: string; ownerId: string; blockId: string | null }> = {}) => {
  const { id = 'pl-1', ownerId = SYSTEM_OWNER_ID, blockId = null } = overrides;
  db.prepare(
    `INSERT INTO placement_log
       (id, owner_id, block_id, task_id, slot_key, auto_run_id,
        chosen_start_at, chosen_end_at, chosen_hour, fit, candidates,
        moved_start_at, moved_end_at, moved_hour, placed_at, moved_at, local_date)
     VALUES (?, ?, ?, NULL, 'work', NULL,
             '2026-07-01T09:00:00.000Z', '2026-07-01T09:30:00.000Z', 9, 1, '[]',
             NULL, NULL, NULL, '2026-07-01T09:00:00.000Z', NULL, '2026-07-01')`,
  ).run(id, ownerId, blockId);
};

describe('0166 placement evidence schema', () => {
  it('creates placement_log, placement_preferences, placement_survival and both indexes', () => {
    const db = fresh();
    runMigrations(db);

    for (const t of ['placement_log', 'placement_preferences', 'placement_survival']) {
      expect(tableExists(db, t), `table ${t} exists`).toBe(true);
    }
    expect(indexExists(db, 'ix_placement_log_owner_key_date')).toBe(true);
    expect(indexExists(db, 'ix_placement_log_block')).toBe(true);

    // placement_log: surrogate TEXT PK, no CHECK constraints (enums enforced in code).
    expect(pkCols(db, 'placement_log')).toEqual(['id']);
    expect(cols(db, 'placement_log')).toEqual(
      expect.arrayContaining([
        'id', 'owner_id', 'block_id', 'task_id', 'slot_key', 'auto_run_id',
        'chosen_start_at', 'chosen_end_at', 'chosen_hour', 'fit', 'candidates',
        'moved_start_at', 'moved_end_at', 'moved_hour', 'placed_at', 'moved_at', 'local_date',
      ]),
    );

    // Rollups: composite PK, no surrogate id — mirrors classification_exemplars (0149).
    expect(cols(db, 'placement_preferences')).not.toContain('id');
    expect(pkCols(db, 'placement_preferences')).toEqual(['owner_id', 'slot_key']);
    expect(cols(db, 'placement_survival')).not.toContain('id');
    expect(pkCols(db, 'placement_survival')).toEqual(['owner_id', 'computed_date']);

    db.close();
  });

  it('running the migration twice is a no-op', () => {
    const db = fresh();
    runMigrations(db);
    expect(runMigrations(db).applied).toEqual([]); // runner skips already-applied ids
    expect(() => m0166.up(db)).not.toThrow(); // CREATE TABLE/INDEX IF NOT EXISTS guard on direct re-run too
    for (const t of ['placement_log', 'placement_preferences', 'placement_survival']) {
      expect(tableExists(db, t)).toBe(true);
    }
    db.close();
  });

  it('leaves the schema sound (integrity + FK check clean)', () => {
    const db = fresh();
    runMigrations(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('DELETE FROM owners cascades all three tables to zero', () => {
    const db = fresh();
    runMigrations(db);
    db.pragma('foreign_keys = ON');

    // A fresh, unseeded owner — SYSTEM_OWNER_ID is the migration seed and carries
    // NO-ACTION-FK'd rows in scheduling_prefs/tags/patterns/etc that would need
    // clearing first; a plain new owner isolates the cascade this ticket adds.
    const ownerId = 'owner-cascade-1';
    db.prepare(`INSERT INTO owners (id, name) VALUES (?, 'Cascade Owner')`).run(ownerId);

    insertLog(db, { id: 'pl-cascade', ownerId });
    db.prepare(
      `INSERT INTO placement_preferences (owner_id, slot_key, p25_hour, p50_hour, p75_hour, corrections, sample_count, computed_date)
       VALUES (?, 'work', 8.5, 9.0, 9.5, 5, 20, '2026-07-01')`,
    ).run(ownerId);
    db.prepare(
      `INSERT INTO placement_survival (owner_id, computed_date, period_days, decided, accepted, corrected, survival_rate, keys_learned, biased)
       VALUES (?, '2026-07-01', 7, 10, 8, 2, 0.8, 1, 0)`,
    ).run(ownerId);

    expect(count(db, 'placement_log')).toBe(1);
    expect(count(db, 'placement_preferences')).toBe(1);
    expect(count(db, 'placement_survival')).toBe(1);

    db.prepare(`DELETE FROM owners WHERE id = ?`).run(ownerId);

    expect(count(db, 'placement_log')).toBe(0);
    expect(count(db, 'placement_preferences')).toBe(0);
    expect(count(db, 'placement_survival')).toBe(0);

    db.close();
  });

  it('a placement_log row survives deletion of its block_id block (no FK, no cascade)', () => {
    const db = fresh();
    runMigrations(db);
    db.pragma('foreign_keys = ON');

    const blockId = '00000000-0000-7000-8000-0000000000c1';
    db.prepare(
      `INSERT INTO time_blocks (id, title, start_at, end_at, owner_id) VALUES (?, 'B', '2026-07-01T09:00:00Z', '2026-07-01T09:30:00Z', ?)`,
    ).run(blockId, SYSTEM_OWNER_ID);
    insertLog(db, { id: 'pl-survives', blockId });

    expect(count(db, 'placement_log')).toBe(1);

    db.prepare(`DELETE FROM time_blocks WHERE id = ?`).run(blockId);

    // The block is gone, but the evidence row is untouched — block_id is not a FK.
    expect(count(db, 'time_blocks')).toBe(0);
    const row = db.prepare(`SELECT block_id FROM placement_log WHERE id = ?`).get('pl-survives') as { block_id: string };
    expect(row.block_id).toBe(blockId);

    db.close();
  });
});
