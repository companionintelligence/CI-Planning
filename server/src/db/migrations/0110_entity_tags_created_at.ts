import type { Database } from 'better-sqlite3';

export const id = '0110_entity_tags_created_at';

/**
 * Phase W · W4a — timestamp `entity_tags` so the GraphQL Taggable edge can expose
 * `EntityTagType.taggedAt` (a non-null `DateTime!`).
 *
 * SQLite forbids `ALTER TABLE … ADD COLUMN … DEFAULT CURRENT_TIMESTAMP` (a non-constant
 * default on ADD COLUMN is a hard error), and rebuilding entity_tags would mean recreating
 * its tag_id FK (ON DELETE CASCADE) + composite PK. So the lowest-risk path is used here:
 *
 *   1. ADD COLUMN created_at TEXT (nullable — allowed).
 *   2. Backfill existing rows to a real ISO-8601 UTC instant. Historical tag-application
 *      times are unknown, so "migration time" is the honest best value.
 *   3. NEW inserts set created_at at write time — the ONLY write path is the `insertAssoc`
 *      prepared statement in services/tags.ts (updated in this ticket's first commit), so
 *      every future row is non-null too.
 *
 * The column stays nullable at the DB level (no rebuild to add a NOT NULL), but every
 * existing AND future row carries a value, so `taggedAt: DateTime!` never serializes a null.
 *
 * Idempotent via the addColumn-if-missing pattern (some tests replay migrations on a fresh
 * DB); the backfill's `WHERE created_at IS NULL` makes step 2 a no-op on replay.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(entity_tags)`).all() as { name: string }[];
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has('created_at')) {
    db.exec(`ALTER TABLE entity_tags ADD COLUMN created_at TEXT`);
  }
  db.exec(
    `UPDATE entity_tags SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at IS NULL`,
  );
}
