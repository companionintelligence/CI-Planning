import type { Database } from 'better-sqlite3';
import { rebuildTable } from '../migrate.js';

export const id = '0114_possible_tasks_owner_scope';
// Rebuild toggles foreign_keys OFF/ON (a no-op inside a transaction). CON-1.
export const manual = true;

/**
 * Phase AA (adversarial-review fix) — two changes to `possible_tasks`, one rebuild:
 *
 * 1. OWNER-SCOPE THE DEDUP KEY. The 0001 baseline gave the table a GLOBAL
 *    `UNIQUE(source_kind, source_ref)` (preserved verbatim by the 0030 rebuild;
 *    never modeled in schema.ts). Under multi-tenant that key crosses owners: in
 *    fixture mode every owner reads the same graph.json, so owner A's row on a
 *    source_ref blocks (or gets overwritten by) owner B's. The app-side dedup
 *    queries (upsertPossible, memory-suggest) now filter by `proposed_owner_id`,
 *    which REQUIRES the constraint to become
 *    `UNIQUE(proposed_owner_id, source_kind, source_ref)` — otherwise owner B's
 *    INSERT throws on A's ref. Same shape as T2's tags fix (F-TAGUNIQUE, 0100).
 *    No dedupe pass is needed: every row satisfying the old (stricter) global
 *    key satisfies the new scoped one.
 *
 * 2. ADD `proposed_estimated_minutes INTEGER` (nullable), appended LAST. Carries
 *    the extractor's / memory template's duration estimate through the inbox so
 *    promote can land it on `tasks.estimated_minutes` — without it, hands-off
 *    auto-scheduling (requireEstimate) never places an accepted suggestion.
 *
 * SQLite can't alter a table-body UNIQUE in place, so we rebuild via the
 * canonical `rebuildTable` dance (manages its own tx + foreign_keys pragma —
 * hence `manual`). The new table reproduces the LIVE physical shape faithfully:
 * same column ORDER (the schema-shape characterization golden captures PRAGMA
 * order), same per-column types/defaults/nullability, with the new column
 * appended last. Both 0092 indexes are recreated via `afterSql` (the DROP drops
 * them). The golden is regenerated in the same PR; the only diff is the new column.
 *
 * Idempotent: guards on `proposed_estimated_minutes` already existing (both
 * changes land together), so a re-run — or an already-rebuilt DB — is a no-op.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(possible_tasks)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (cols.includes('proposed_estimated_minutes')) return; // already rebuilt — re-run safety.

  rebuildTable(db, {
    table: 'possible_tasks',
    createNewSql: `
      CREATE TABLE possible_tasks_new (
        id                         TEXT PRIMARY KEY NOT NULL,
        raw_title                  TEXT NOT NULL,
        raw_summary                TEXT,
        proposed_due_at            TEXT,
        proposed_priority          INTEGER,
        proposed_owner_id          TEXT REFERENCES owners(id),
        source_kind                TEXT,
        source_ref                 TEXT,
        source_payload             TEXT,
        confidence                 REAL,
        status                     TEXT DEFAULT 'pending',
        promoted_task_id           TEXT REFERENCES tasks(id),
        created_at                 TEXT DEFAULT CURRENT_TIMESTAMP,
        proposed_estimated_minutes INTEGER,
        UNIQUE(proposed_owner_id, source_kind, source_ref)
      );`,
    columns:
      'id, raw_title, raw_summary, proposed_due_at, proposed_priority, proposed_owner_id, ' +
      'source_kind, source_ref, source_payload, confidence, status, promoted_task_id, created_at',
    afterSql: `
      CREATE INDEX IF NOT EXISTS ix_possible_tasks_proposed_owner ON possible_tasks(proposed_owner_id);
      CREATE INDEX IF NOT EXISTS ix_possible_tasks_promoted_task  ON possible_tasks(promoted_task_id);
    `,
  });
}
