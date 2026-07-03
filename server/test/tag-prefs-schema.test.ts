import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0097 from '../src/db/migrations/0097_tag_prefs.js';

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');
const tableExists = (db: Database, name: string) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const cols = (db: Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('0097 tag_prefs merge', () => {
  it('creates tag_prefs and drops pattern_prefs + category_prefs', () => {
    const db = fresh();
    runMigrations(db);

    expect(tableExists(db, 'tag_prefs')).toBe(true);
    expect(tableExists(db, 'pattern_prefs')).toBe(false);
    expect(tableExists(db, 'category_prefs')).toBe(false);
    expect(cols(db, 'tag_prefs')).toEqual(
      expect.arrayContaining(['id', 'owner_id', 'tag_id', 'kind', 'auto_fill', 'reminder_offsets', 'icon_shape', 'color_token', 'default_minutes']),
    );
    db.close();
  });

  it('leaves the schema sound and is idempotent', () => {
    const db = fresh();
    runMigrations(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(runMigrations(db).applied).toEqual([]);
    expect(() => m0097.up(db)).not.toThrow(); // guard: tag_prefs already exists
    db.close();
  });

  it('backfills both axes with the right kind; pattern-only cols are NULL for category rows', () => {
    const db = fresh();
    db.exec(`
      CREATE TABLE owners (id TEXT PRIMARY KEY);
      INSERT INTO owners (id) VALUES ('o1');
      CREATE TABLE tags (id TEXT PRIMARY KEY, kind TEXT);
      INSERT INTO tags (id, kind) VALUES ('pt1', 'pattern'), ('ct1', 'category');
      CREATE TABLE pattern_prefs (
        id TEXT PRIMARY KEY, owner_id TEXT, direction_tag_id TEXT, auto_fill INTEGER,
        reminder_offsets TEXT, icon_shape TEXT, color_token TEXT, default_minutes INTEGER,
        UNIQUE (owner_id, direction_tag_id)
      );
      CREATE TABLE category_prefs (
        id TEXT PRIMARY KEY, owner_id TEXT, category_tag_id TEXT, color_token TEXT, default_minutes INTEGER,
        UNIQUE (owner_id, category_tag_id)
      );
      INSERT INTO pattern_prefs (id, owner_id, direction_tag_id, auto_fill, reminder_offsets, icon_shape, color_token, default_minutes)
        VALUES ('pp1', 'o1', 'pt1', 0, '[5,10]', 'square', 'chart-2', 45);
      INSERT INTO category_prefs (id, owner_id, category_tag_id, color_token, default_minutes)
        VALUES ('cp1', 'o1', 'ct1', 'chart-1', 90);
    `);

    m0097.up(db);

    const rows = db
      .prepare(`SELECT * FROM tag_prefs WHERE owner_id='o1' ORDER BY kind`)
      .all() as any[];
    expect(rows).toHaveLength(2);

    // category row first (ORDER BY kind): only the shared cols, pattern-only NULL
    expect(rows[0]).toMatchObject({ tag_id: 'ct1', kind: 'category', color_token: 'chart-1', default_minutes: 90 });
    expect(rows[0].auto_fill).toBeNull();
    expect(rows[0].reminder_offsets).toBeNull();
    expect(rows[0].icon_shape).toBeNull();

    // pattern row: all columns carried over
    expect(rows[1]).toMatchObject({
      tag_id: 'pt1', kind: 'pattern', auto_fill: 0, reminder_offsets: '[5,10]',
      icon_shape: 'square', color_token: 'chart-2', default_minutes: 45,
    });

    expect(tableExists(db, 'pattern_prefs')).toBe(false);
    expect(tableExists(db, 'category_prefs')).toBe(false);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
