import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { up as scrub } from '../src/db/migrations/0122_scrub_seed_owner.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';

// Isolated in-memory DBs — never the shared file DB (same pattern as migrate.test.ts).
const fresh = () => new BetterSqlite3(':memory:');

function ownerRow(db: BetterSqlite3.Database): { name: string; email: string | null } {
  return db
    .prepare('SELECT name, email FROM owners WHERE id = ?')
    .get(SYSTEM_OWNER_ID) as { name: string; email: string | null };
}

describe('seeded system owner carries no personal identity', () => {
  it('a fresh DB seeds the neutral System owner (0003)', () => {
    const db = fresh();
    runMigrations(db);
    expect(ownerRow(db)).toEqual({ name: 'System', email: null });
    db.close();
  });

  it('0122 scrubs a DB seeded with the old personal literals', () => {
    const db = fresh();
    runMigrations(db);
    // Simulate a pre-fix install: the old 0003 literals survived 0030's id remap.
    db.prepare(`UPDATE owners SET name = 'Liam', email = 'REDACTED-DEV-EMAIL@example.invalid' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    scrub(db);
    expect(ownerRow(db)).toEqual({ name: 'System', email: null });
    // Idempotent: a second pass changes nothing.
    scrub(db);
    expect(ownerRow(db)).toEqual({ name: 'System', email: null });
    db.close();
  });

  it('0122 never touches a personalized owner row', () => {
    const db = fresh();
    runMigrations(db);
    db.prepare(`UPDATE owners SET name = 'Alex', email = 'alex@example.com' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    scrub(db);
    expect(ownerRow(db)).toEqual({ name: 'Alex', email: 'alex@example.com' });
    // Same guard when only ONE of the two literals matches (renamed but same email).
    db.prepare(`UPDATE owners SET name = 'Alex', email = 'REDACTED-DEV-EMAIL@example.invalid' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    scrub(db);
    expect(ownerRow(db)).toEqual({ name: 'Alex', email: 'REDACTED-DEV-EMAIL@example.invalid' });
    db.close();
  });
});
