import type { Database } from 'better-sqlite3';

export const id = '0050_owner_external_subject';

/**
 * Phase I (PR2) — SSO subject mapping. A CI-Server-minted JWT carries the owner
 * identity in its `sub` claim; this column maps that external subject to the local
 * owner row so a verified token resolves to an `ownerId`. UNIQUE so one subject
 * maps to exactly one owner. NULL for owners that only ever use an api key.
 * Additive + idempotent (column-add guarded).
 */
export function up(db: Database): void {
  const hasCol = (db.prepare(`PRAGMA table_info(owners)`).all() as { name: string }[]).some(
    (c) => c.name === 'external_subject',
  );
  if (!hasCol) {
    db.exec(`ALTER TABLE owners ADD COLUMN external_subject TEXT;`);
  }
  // Partial UNIQUE index: enforce uniqueness only for owners that have a subject
  // (multiple NULLs are allowed — api-key-only owners never set one).
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_owners_external_subject
       ON owners(external_subject) WHERE external_subject IS NOT NULL;`,
  );
}
