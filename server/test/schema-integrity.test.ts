import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { sqlite } from '../src/db/index.js';

/**
 * Q5 — phase-level safety net. After the FULL migration set runs, the schema must
 * be structurally sound (`integrity_check`) and free of dangling foreign keys
 * (`foreign_key_check`). Any future migration that corrupts the schema or leaves an
 * orphan fails here in CI. Checked on both a fresh in-memory DB (deterministic, the
 * migration set in isolation) and the shared app DB (the real db/index.ts path).
 */
describe('schema integrity after all migrations', () => {
  it('a freshly migrated DB passes integrity_check and foreign_key_check', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);

    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);

    db.close();
  });

  it('the shared app DB (db/index.ts) is structurally sound and orphan-free', () => {
    // db/index.ts opens with foreign_keys=ON and runs the migrations on import.
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});
