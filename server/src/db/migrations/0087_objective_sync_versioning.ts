import type { Database } from 'better-sqlite3';

export const id = '0087_objective_sync_versioning';

/**
 * Follow-up 2 (option B) — bring `objectives` + `objective_tasks` into the
 * Phase L field-level sync layer (mirrors `0076_sync_versioning`).
 *
 * - `objectives` already carries `updated_at`, so it only needs `version`
 *   (monotonic per-op counter) and `field_ts` (JSON per-field LWW map).
 * - `objective_tasks` was a bare composite-PK join table with no addressable
 *   row identity and no mutable fields — unsuitable for the row-by-id apply
 *   model. We add:
 *     - `id`        — surrogate row identity so a link is an addressable,
 *                     versioned row (backfilled for existing links via uuid7()).
 *     - `linked`    — 1 = active link, 0 = tombstone. Unlink flips this to 0
 *                     instead of deleting the row, so an unlink round-trips
 *                     through LWW (a row deletion cannot merge). All read paths
 *                     filter `linked = 1`.
 *     - `version` / `updated_at` / `field_ts` — same LWW machinery as tasks.
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
 * Forward-only.
 */
export function up(db: Database): void {
  const objCols = (db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map((c) => c.name);
  if (!objCols.includes('version'))  db.exec(`ALTER TABLE objectives ADD COLUMN version  INTEGER NOT NULL DEFAULT 1`);
  if (!objCols.includes('field_ts')) db.exec(`ALTER TABLE objectives ADD COLUMN field_ts TEXT`);

  const linkCols = (db.prepare('PRAGMA table_info(objective_tasks)').all() as { name: string }[]).map((c) => c.name);
  if (!linkCols.includes('id'))         db.exec(`ALTER TABLE objective_tasks ADD COLUMN id         TEXT`);
  if (!linkCols.includes('linked'))     db.exec(`ALTER TABLE objective_tasks ADD COLUMN linked     INTEGER NOT NULL DEFAULT 1`);
  if (!linkCols.includes('version'))    db.exec(`ALTER TABLE objective_tasks ADD COLUMN version    INTEGER NOT NULL DEFAULT 1`);
  if (!linkCols.includes('updated_at')) db.exec(`ALTER TABLE objective_tasks ADD COLUMN updated_at TEXT`);
  if (!linkCols.includes('field_ts'))   db.exec(`ALTER TABLE objective_tasks ADD COLUMN field_ts   TEXT`);

  // Backfill a stable surrogate id for pre-existing links. Uses SQLite built-ins
  // only (randomblob is evaluated per-row) rather than the app's uuid7() UDF, so
  // this migration also runs on a bare connection (the migration-runner tests open
  // a fresh DB without registering uuid7). The exact id format is irrelevant — it's
  // an internal surrogate key, only required to be unique. New links written by the
  // app supply a uuid7 id via routes/objectives.ts. A UNIQUE index gives the
  // row-by-id apply path a keyable identity without disturbing the composite PK.
  db.exec(`UPDATE objective_tasks SET id = lower(hex(randomblob(16))) WHERE id IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ix_objective_tasks_id ON objective_tasks(id)`);
}
