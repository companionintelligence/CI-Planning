import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0096 from '../src/db/migrations/0096_daily_recap.js';

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');
const tableExists = (db: Database, name: string) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const cols = (db: Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('0096 daily_recap merge', () => {
  it('creates daily_recap and drops daily_summaries + day_stars', () => {
    const db = fresh();
    runMigrations(db);

    expect(tableExists(db, 'daily_recap')).toBe(true);
    expect(tableExists(db, 'daily_summaries')).toBe(false);
    expect(tableExists(db, 'day_stars')).toBe(false);

    // Both groups present under one grain.
    const c = cols(db, 'daily_recap');
    expect(c).toEqual(
      expect.arrayContaining([
        'owner_id', 'date', 'prose', 'stats', 'focus', 'llm', 'inputs_hash',
        'star_objective', 'star_habits', 'star_tasks', 'star_bonus', 'star_note', 'total', 'frozen_at',
      ]),
    );
    db.close();
  });

  it('leaves the schema sound and is idempotent', () => {
    const db = fresh();
    runMigrations(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(runMigrations(db).applied).toEqual([]);
    expect(() => m0096.up(db)).not.toThrow(); // guard: daily_recap already exists
    db.close();
  });

  it('backfills both sources, preserving sparse days (summary-only, stars-only, both)', () => {
    // Hand-build the pre-0096 world, then run ONLY the merge migration against it.
    const db = fresh();
    db.exec(`
      CREATE TABLE owners (id TEXT PRIMARY KEY);
      INSERT INTO owners (id) VALUES ('o1');
      CREATE TABLE daily_summaries (
        owner_id TEXT, date TEXT, prose TEXT, stats TEXT, focus TEXT, llm INTEGER,
        inputs_hash TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (owner_id, date)
      );
      CREATE TABLE day_stars (
        owner_id TEXT, date TEXT, star_objective INTEGER, star_habits INTEGER, star_tasks INTEGER,
        star_bonus INTEGER, star_note INTEGER, total INTEGER, frozen_at TEXT, PRIMARY KEY (owner_id, date)
      );
      -- summary-only day
      INSERT INTO daily_summaries (owner_id, date, prose, stats, focus, llm, inputs_hash)
        VALUES ('o1', '2026-01-01', 'Brief A', '{}', '[]', 1, 'h1');
      -- stars-only day (frozen)
      INSERT INTO day_stars (owner_id, date, star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at)
        VALUES ('o1', '2026-01-02', 1, 0, 0, 0, 0, 1, '2026-01-03T00:20:00.000Z');
      -- both
      INSERT INTO daily_summaries (owner_id, date, prose, stats, focus, llm, inputs_hash)
        VALUES ('o1', '2026-01-03', 'Brief C', '{}', '[]', 0, 'h3');
      INSERT INTO day_stars (owner_id, date, star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at)
        VALUES ('o1', '2026-01-03', 1, 1, 0, 0, 0, 2, '2026-01-04T00:20:00.000Z');
    `);

    m0096.up(db);

    const rows = db
      .prepare(`SELECT * FROM daily_recap WHERE owner_id='o1' ORDER BY date`)
      .all() as any[];
    expect(rows).toHaveLength(3);

    // summary-only: prose set, stars + frozen_at NULL
    expect(rows[0]).toMatchObject({ date: '2026-01-01', prose: 'Brief A', llm: 1 });
    expect(rows[0].star_objective).toBeNull();
    expect(rows[0].frozen_at).toBeNull();

    // stars-only: stars/frozen_at set, prose NULL
    expect(rows[1]).toMatchObject({ date: '2026-01-02', star_objective: 1, total: 1 });
    expect(rows[1].prose).toBeNull();
    expect(rows[1].frozen_at).toBe('2026-01-03T00:20:00.000Z');

    // both: summary + stars co-located
    expect(rows[2]).toMatchObject({ date: '2026-01-03', prose: 'Brief C', star_habits: 1, total: 2 });

    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
