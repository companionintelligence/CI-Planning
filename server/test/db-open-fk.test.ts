import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db/open.js';

// Isolated in-memory DBs — these tests never touch the shared file DB.

describe('openDb', () => {
  it('yields a connection whose foreign_keys enforcement is ON (the contract)', () => {
    // openDb GUARANTEES foreign_keys=ON regardless of the build default. On the
    // standard SQLite library FK is OFF by default, so this is the load-bearing
    // assertion that openDb set it (and would fail red if that pragma were
    // removed). NOTE: the bundled better-sqlite3 binary happens to default FK ON,
    // so on THIS build the guarantee is redundant — but it's the correct contract
    // to assert and keeps every open portable to a build that defaults it OFF.
    const db = openDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('enforces FK constraints — an FK-off connection permits an orphan, openDb rejects it', () => {
    // A tiny self-contained FK schema — no runMigrations, so nothing else can
    // toggle foreign_keys and mask the result.
    const schema = `
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child  (parent_id TEXT REFERENCES parent(id));`;
    const orphan = `INSERT INTO child (parent_id) VALUES ('does-not-exist')`;

    // With enforcement OFF the orphan is permitted — this proves the throw below
    // is genuinely FK-driven, not some unrelated constraint.
    const off = new BetterSqlite3(':memory:');
    off.pragma('foreign_keys = OFF');
    off.exec(schema);
    expect(() => off.prepare(orphan).run()).not.toThrow();
    off.close();

    // A connection from openDb enforces the FK: the same orphan throws.
    const on = openDb(':memory:');
    on.exec(schema);
    expect(() => on.prepare(orphan).run()).toThrow(/FOREIGN KEY/i);
    on.close();
  });
});
