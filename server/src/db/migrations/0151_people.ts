import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0151_people';

/**
 * People on work (docs/people-on-work.md) — the person directory, its email index, and
 * the two peer people-sets an item carries.
 *
 * ⚠️ `people.owner_id` and `people.account_id` BOTH reference owners(id) and mean
 * completely different things. This is the single most misreadable line in the design,
 * so it is stated on the column and again here:
 *
 *   - owner_id   — TENANCY. Whose directory this row lives in. Identical in meaning to
 *                  owner_id on every other table; every read filters by it.
 *   - account_id — the permissioned ACCOUNT this person *is*, when they have a login on
 *                  this install. NULL for the overwhelming majority of people (a
 *                  spouse, a client, a plumber). Accounts are a convenience — they make
 *                  a roster available to pre-fill from — never a condition on who can be
 *                  named on an item.
 *
 * `entity_people` carries BOTH sets, distinguished only by `role`:
 *   - 'responsible' — who does the work
 *   - 'beneficiary' — who the work is for
 *
 * `role` is part of the PRIMARY KEY because the same person legitimately appears in both
 * sets — you are usually both responsible for and a beneficiary of your own work. That
 * is precisely why the two fields share one table and one model rather than two shapes.
 *
 * NO cardinality constraint on either set: both are plain multi-selects. "The lead" is
 * position = 0 within 'responsible', a display convention rather than a schema rule —
 * so nothing here has to be relaxed if an item genuinely has two equal leads.
 *
 * Values ('responsible' | 'beneficiary', and the source vocabulary) are enforced in
 * code, not CHECK constraints — repo convention, stated in 0141.
 *
 * Idempotent throughout (CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE), so a re-run on
 * a partially-migrated database is a no-op.
 */
export function up(db: Database): void {
  // ── people: the per-tenant directory ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id           TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,   -- TENANCY: whose directory
      account_id   TEXT REFERENCES owners(id) ON DELETE SET NULL,           -- the ACCOUNT this person IS, if any
      display_name TEXT NOT NULL,
      confirmed    INTEGER NOT NULL DEFAULT 1,   -- 0 = provisionally created by ingest, never user-confirmed
      source       TEXT,                          -- 'manual' | 'account' | 'gcal' | 'gmail' | 'llm'
      notes        TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_people_owner_name ON people (owner_id, display_name)`);
  // Partial: only rows that ARE an account are constrained — the many NULLs must not
  // collide with each other (SQLite treats NULLs as distinct in a UNIQUE index, but the
  // predicate makes the intent explicit and keeps the index small).
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_people_owner_account
       ON people (owner_id, account_id) WHERE account_id IS NOT NULL`,
  );

  // ── person_emails: the deterministic matching key ─────────────────────────
  // Owner-scoped uniqueness, NOT global: the same address may legitimately be two
  // different people across two tenants, and a global key would let one tenant's
  // directory decide who another tenant's mail is from.
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_emails (
      owner_id  TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      email     TEXT NOT NULL,                     -- stored lowercased by services/people.ts
      PRIMARY KEY (owner_id, email)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_person_emails_person ON person_emails (person_id)`);

  // ── entity_people: both sets, for tasks AND time blocks ───────────────────
  // A structural mirror of entity_categories (0134): same entity-spanning idiom, same
  // no-FK-on-entity_id rule (it points at tasks OR time_blocks), same position column,
  // same created_at default.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_people (
      entity_kind TEXT NOT NULL,                   -- 'task' | 'time_block'
      entity_id   TEXT NOT NULL,                   -- PK of the entity (no FK — spans tables)
      person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,                   -- 'responsible' | 'beneficiary'
      source      TEXT,                            -- 'user' | 'llm' | 'calendar' | 'email'
      position    INTEGER NOT NULL DEFAULT 0,      -- 0 within 'responsible' = the lead
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_kind, entity_id, person_id, role)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_entity_people_entity ON entity_people (entity_kind, entity_id, role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_entity_people_person ON entity_people (person_id)`);

  // ── Seed each owner's own row ─────────────────────────────────────────────
  // Without this the "me" shortcut has nothing to point at on an existing install, so
  // the feature would appear broken until the user manually created themselves.
  // account_id = owner_id is what marks a row as "this is me" — is_self is DERIVED,
  // never stored, so the two can never disagree.
  //
  // Only the self row is seeded. Other accounts are NOT pre-copied into every
  // directory: the `us` roster resolves them at request time and services/people.ts
  // creates the local person row lazily, the first time one is actually attached. A
  // migration that fanned every account into every directory would duplicate
  // cross-tenant data that nobody has referenced yet.
  const owners = db.prepare(`SELECT id, name, email FROM owners`).all() as {
    id: string; name: string | null; email: string | null;
  }[];
  const existingSelf = db.prepare(`SELECT id FROM people WHERE owner_id = ? AND account_id = ?`);
  const existingName = db.prepare(`SELECT id FROM people WHERE owner_id = ? AND display_name = ?`);
  const insPerson = db.prepare(
    `INSERT INTO people (id, owner_id, account_id, display_name, confirmed, source)
     VALUES (?, ?, ?, ?, 1, 'account')`,
  );
  const insEmail = db.prepare(
    `INSERT OR IGNORE INTO person_emails (owner_id, person_id, email) VALUES (?, ?, ?)`,
  );

  for (const o of owners) {
    if (existingSelf.get(o.id, o.id)) continue;
    // display_name is UNIQUE per owner, so a pre-existing person with the same name
    // would collide. Fall back to adopting that row as the self row rather than
    // failing the migration — a name clash here means the user already created
    // themselves by hand.
    const name = (o.name ?? '').trim() || 'Me';
    const clash = existingName.get(o.id, name) as { id: string } | undefined;
    if (clash) {
      db.prepare(`UPDATE people SET account_id = ?, source = 'account' WHERE id = ?`).run(o.id, clash.id);
      if (o.email) insEmail.run(o.id, clash.id, o.email.trim().toLowerCase());
      continue;
    }
    const pid = newId();
    insPerson.run(pid, o.id, o.id, name);
    if (o.email) insEmail.run(o.id, pid, o.email.trim().toLowerCase());
  }
}
