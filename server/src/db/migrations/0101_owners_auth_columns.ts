import type { Database } from 'better-sqlite3';

export const id = '0101_owners_auth_columns';

/**
 * U0 (= Phase T's "T5", folded into Phase U per owner decision) — give `owners`
 * the auth-identity columns Phase U populates, so "owner ≡ user" (Phase T decision
 * #1) becomes real. Purely additive; no data change to existing rows.
 *
 *   - `external_subject` — the CI-Portal OIDC token `sub`, mapped 1:1 to a local
 *     owner. Populated by U1 (SSO). NULL until then.
 *   - `username`         — local-login handle. Populated by U2. NULL for OIDC-only owners.
 *   - `password_hash`    — argon2id hash for local login. Populated by U2. NULL for OIDC owners.
 *
 * No `auth_kind` column: an owner's auth mode is inferable from which columns are
 * non-null (external_subject ⇒ OIDC; username/password_hash ⇒ local; all NULL ⇒
 * the SYSTEM_OWNER sentinel / dev-test single owner).
 *
 * UNIQUENESS — why separate indexes, not inline constraints: SQLite's
 * `ALTER TABLE ... ADD COLUMN` **cannot** add a column carrying a UNIQUE (or PRIMARY
 * KEY) constraint, so we add the columns plain and enforce uniqueness with
 * **partial** unique indexes (`WHERE col IS NOT NULL`). SQLite already treats NULLs
 * as distinct in a unique index, so the partial `WHERE` is belt-and-suspenders — it
 * makes the intent explicit and keeps the index off the (many, until U1/U2) NULL
 * rows. This matches the house pattern (0007/0027/0034 partial unique indexes).
 *
 * N-SENTINEL: the single `SYSTEM_OWNER` row (`lib/ids.ts` sentinel) keeps all three
 * columns NULL — it is auth-inert. Because every column is nullable and the unique
 * indexes are partial, the sentinel neither blocks nor collides with any future
 * signup. U1's auto-provisioning and U2's login lookup must *additionally* exclude
 * `owners.id = SYSTEM_OWNER_ID` so an external login can never take over the sentinel
 * identity — that behavioral guard lands with U1/U2; U0 only guarantees the sentinel
 * is auth-inert at the schema level (asserted in owners-auth.test.ts).
 *
 * G-BASETAG (deferred, owned by U1/U2): a newly-provisioned owner needs its own base
 * pattern tags seeded (the base Home/Work/Community set is seeded once globally today,
 * 0036/0069) or Auto silently places nothing for them. That is owner-*creation*
 * behavior — it belongs to U1's auto-provision path, not this schema migration.
 *
 * Additive + idempotent: guards on the column already existing (historical-replay
 * safe — migrate.test.ts replays the full set on a legacy-shaped owners table).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(owners)`).all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('external_subject')) return; // already migrated — re-run safety.

  db.exec(`
    ALTER TABLE owners ADD COLUMN external_subject TEXT;
    ALTER TABLE owners ADD COLUMN username         TEXT;
    ALTER TABLE owners ADD COLUMN password_hash    TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS ux_owners_external_subject
      ON owners(external_subject) WHERE external_subject IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_owners_username
      ON owners(username) WHERE username IS NOT NULL;
  `);
}
