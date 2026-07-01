import type { Database } from 'better-sqlite3';
import { rebuildTable } from '../migrate.js';

export const id = '0093_flight_plan_notnull';
// Rebuild toggles foreign_keys OFF/ON (a no-op inside a transaction). CON-1.
export const manual = true;

/**
 * Q3 (schema hygiene) — make `flight_plan.owner_id` `TEXT NOT NULL`.
 *
 * `owner_id` is one half of the composite PK `(owner_id, task_id)`, yet it was
 * left nullable — the last schema outlier where a PK/owner column allows NULL
 * (0030 retyped it INTEGER→TEXT but kept `notnull=0`). SQLite can't add a NOT
 * NULL constraint in place, so we rebuild the table via the canonical
 * `rebuildTable` 12-step dance (which manages its own tx + foreign_keys pragma —
 * hence `manual`).
 *
 * `flight_plan` is a LEAF table (nothing FK-references it) with NO indexes
 * besides the auto PK index (verified: 0016 created none, 0081 explicitly notes
 * "no index", 0092 fk_indexes did not touch it) — so no `afterSql` is needed.
 *
 * The new table reproduces the LIVE physical shape faithfully — same column ORDER
 * (0016's `owner_id, task_id, selected, position, added_at`, then 0081-appended
 * `source_kind, source_ref` after `source_pattern_id` was dropped) and same
 * per-column constraints (`source_kind` stays `NOT NULL DEFAULT 'manual'` from
 * 0081) — so the ONLY change is `owner_id` gaining NOT NULL. Preserving column
 * order keeps the schema-shape characterization golden (baseline test) stable and
 * avoids a gratuitous `SELECT *` reordering.
 *
 * We deliberately do NOT add `ON DELETE CASCADE` to the `owner_id` FK: owners are
 * never deleted today, and adding cascade would be a behavior change out of scope.
 *
 * Idempotent: guards on `owner_id.notnull` so a re-run (or an already-rebuilt DB)
 * is a no-op.
 */
export function up(db: Database): void {
  const ownerCol = (db.prepare(`PRAGMA table_info(flight_plan)`).all() as {
    name: string;
    notnull: number;
  }[]).find((c) => c.name === 'owner_id');
  if (ownerCol?.notnull === 1) return; // already NOT NULL — re-run safety.

  rebuildTable(db, {
    table: 'flight_plan',
    createNewSql: `
      CREATE TABLE flight_plan_new (
        owner_id    TEXT NOT NULL REFERENCES owners(id),
        task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        selected    INTEGER DEFAULT 1,
        position    INTEGER DEFAULT 0,
        added_at    TEXT DEFAULT CURRENT_TIMESTAMP,
        source_kind TEXT NOT NULL DEFAULT 'manual',
        source_ref  TEXT,
        PRIMARY KEY (owner_id, task_id)
      );`,
    columns: 'owner_id, task_id, selected, position, added_at, source_kind, source_ref',
  });
}
