import type { Database } from 'better-sqlite3';

export const id = '0173_classification_entity_kind';

/**
 * What kind of thing a `classification_log` row is about. The log was written for tasks,
 * and `task_id` named the task. Time Blocks carry categories too, and their evidence has to
 * live in the same table (one vocabulary, one learner), so a row now says what its id means:
 * `'task'` (the id is a `tasks` row) or `'time_block'` (the id is a `time_blocks` row). The
 * column keeps its name `task_id` because SQLite cannot rename it without rebuilding a table
 * other code reads; `(entity_kind, task_id)` is the entity.
 *
 * Every row that exists before this migration is a task row, which is what the DEFAULT says,
 * so there is no backfill and nothing to guess. Values are enforced in code, not by a CHECK
 * constraint (repo convention). Like the rest of the table it is read and written through raw
 * SQL only and is not mirrored in schema.ts.
 *
 * The correction read ("the still-open assignment for this entity and field") now filters on
 * the kind too, so a task and a block that ever shared an id could not settle each other's
 * row. The learning reads (one owner, one field, a date window) do not filter on it: the
 * vocabulary is the same, so a Time Block correction teaches the same index a task
 * correction does, and the kind is there to be counted, not to split the evidence.
 *
 * SQLite-only. The Postgres baseline stops at migration 0147 (server/db/postgres/README.md).
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(classification_log)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'entity_kind')) {
    db.exec(`ALTER TABLE classification_log ADD COLUMN entity_kind TEXT NOT NULL DEFAULT 'task'`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_classification_log_entity
      ON classification_log(entity_kind, task_id, field);
  `);
}
