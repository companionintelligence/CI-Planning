import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';

/**
 * U0 (= Phase T's "T5") — `owners` auth-identity columns (migration 0101).
 *
 * Schema-level guarantees U1 (OIDC) and U2 (local login) build on:
 *  - the three columns exist and are all nullable;
 *  - `external_subject` / `username` are UNIQUE when set, but many rows may hold NULL
 *    (partial indexes) so the sentinel + not-yet-authed owners coexist;
 *  - the SYSTEM_OWNER sentinel row is **auth-inert** (all three columns NULL) and can
 *    never be matched by a real external_subject/username lookup (N-SENTINEL). The
 *    *behavioral* `id <> SYSTEM_OWNER_ID` exclusion in the provision/login paths lands
 *    with U1/U2; this file pins the schema-level half of that guarantee now.
 */

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = (): Database => {
  const db = new BetterSqlite3(':memory:');
  runMigrations(db);
  return db;
};
const info = (db: Database) =>
  db.prepare(`PRAGMA table_info(owners)`).all() as { name: string; notnull: number }[];
const addOwner = (
  db: Database,
  o: { id: string; name?: string; externalSubject?: string | null; username?: string | null; passwordHash?: string | null },
) =>
  db
    .prepare(`INSERT INTO owners (id, name, external_subject, username, password_hash) VALUES (?, ?, ?, ?, ?)`)
    .run(o.id, o.name ?? 'test', o.externalSubject ?? null, o.username ?? null, o.passwordHash ?? null);

const OWNER_A = '00000000-0000-7000-8000-0000000000a1';
const OWNER_B = '00000000-0000-7000-8000-0000000000b2';

describe('U0 — owners auth-identity columns (0101)', () => {
  it('adds external_subject, username, password_hash — all nullable', () => {
    const db = fresh();
    const cols = info(db);
    for (const name of ['external_subject', 'username', 'password_hash']) {
      const col = cols.find((c) => c.name === name);
      expect(col, `column ${name} missing`).toBeTruthy();
      expect(col!.notnull, `column ${name} must be nullable`).toBe(0);
    }
    db.close();
  });

  it('leaves the SYSTEM_OWNER sentinel row auth-inert (all three columns NULL)', () => {
    const db = fresh();
    const row = db
      .prepare(`SELECT external_subject, username, password_hash FROM owners WHERE id = ?`)
      .get(SYSTEM_OWNER_ID) as { external_subject: unknown; username: unknown; password_hash: unknown };
    expect(row).toBeTruthy();
    expect(row.external_subject).toBeNull();
    expect(row.username).toBeNull();
    expect(row.password_hash).toBeNull();
    db.close();
  });

  it('enforces UNIQUE external_subject when set', () => {
    const db = fresh();
    addOwner(db, { id: OWNER_A, externalSubject: 'sub-123' });
    expect(() => addOwner(db, { id: OWNER_B, externalSubject: 'sub-123' })).toThrow(/UNIQUE|constraint/i);
    db.close();
  });

  it('enforces UNIQUE username when set', () => {
    const db = fresh();
    addOwner(db, { id: OWNER_A, username: 'admin' });
    expect(() => addOwner(db, { id: OWNER_B, username: 'admin' })).toThrow(/UNIQUE|constraint/i);
    db.close();
  });

  it('allows many owners with NULL auth columns (partial indexes — sentinel coexists)', () => {
    const db = fresh();
    // The sentinel already has NULL auth columns; adding two more NULL-auth owners must
    // not collide (multiple NULLs are distinct under the partial unique indexes).
    expect(() => {
      addOwner(db, { id: OWNER_A });
      addOwner(db, { id: OWNER_B });
    }).not.toThrow();
    expect((db.prepare(`SELECT COUNT(*) n FROM owners WHERE external_subject IS NULL`).get() as { n: number }).n).toBe(3);
    db.close();
  });

  it('the sentinel is never matched by an external_subject/username lookup (N-SENTINEL)', () => {
    const db = fresh();
    // A real login lookup keys on a non-null subject/username — the sentinel (NULL) can
    // never match one, so it can never be silently taken over by an external identity.
    const bySub = db.prepare(`SELECT id FROM owners WHERE external_subject = 'any-real-sub'`).get();
    const byUser = db.prepare(`SELECT id FROM owners WHERE username = 'any-real-user'`).get();
    expect(bySub).toBeUndefined();
    expect(byUser).toBeUndefined();

    // And the exclusion clause U1/U2 must use resolves to the real owner, not the sentinel.
    addOwner(db, { id: OWNER_A, username: 'admin', passwordHash: 'argon2id$…' });
    const found = db
      .prepare(`SELECT id FROM owners WHERE username = ? AND id <> ?`)
      .get('admin', SYSTEM_OWNER_ID) as { id: string } | undefined;
    expect(found?.id).toBe(OWNER_A);
    db.close();
  });
});
