import type { Database } from 'better-sqlite3';

export const id = '0110_entity_tags_created_at';

/**
 * Phase W · W4a — timestamp `entity_tags` so the GraphQL Taggable edge can expose
 * `EntityTagType.taggedAt` (a non-null `DateTime!`).
 *
 * `entity_tags` has SIX runtime insert paths — `services/tags.ts` (insertAssoc), plus
 * `services/auto-tag.ts`, `engine/blocks-recur.ts`, `routes/possibles.ts`,
 * `services/tasks.ts` (recall clone), and `agents/groom.ts`. Per-call-site stamping can't
 * guarantee the non-null invariant (miss one now or add one later and a null `created_at`
 * slips through, which `taggedAt: DateTime!` then fails to serialize). SQLite also forbids
 * a non-constant `DEFAULT` on `ADD COLUMN`. So the STRUCTURAL fix is a table rebuild giving
 * `created_at` a DB-level `NOT NULL DEFAULT CURRENT_TIMESTAMP` (legal in CREATE TABLE):
 * every writer, present and future, gets a value automatically — a null is impossible.
 *
 * `entity_tags` is a leaf (its only FK is OUTBOUND to `tags`; nothing references it), so
 * the drop/rename is safe inside the migration runner's transaction with foreign_keys on.
 * The copy selects only the four base columns, so this is correct whether replayed on the
 * 0033 shape (fresh DB) or a DB that ran an earlier ADD-COLUMN form of this migration (the
 * stray `created_at` is simply not selected; the rebuilt column re-defaults).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE entity_tags_new (
      entity_kind TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      level       INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_kind, entity_id, tag_id)
    );
    INSERT INTO entity_tags_new (entity_kind, entity_id, tag_id, level)
      SELECT entity_kind, entity_id, tag_id, level FROM entity_tags;
    DROP TABLE entity_tags;
    ALTER TABLE entity_tags_new RENAME TO entity_tags;
    CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag_id);
  `);

  // Defensive: the rebuild must leave no dangling tag_id → tags(id) reference.
  const violations = db.pragma('foreign_key_check(entity_tags)') as unknown[];
  if (violations.length > 0) {
    throw new Error(`0110 entity_tags rebuild left ${violations.length} FK violation(s)`);
  }
}
