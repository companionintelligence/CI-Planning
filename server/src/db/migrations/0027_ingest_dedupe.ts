import type { Database } from 'better-sqlite3';

export const id = '0027_ingest_dedupe';

/**
 * Ingest dedupe safety net (post-PR-65 review). `tasks` and `time_blocks` rows
 * sourced from Gmail/GCal carry a `source_kind` + `source_ref` but had no
 * uniqueness guard — re-ingesting the same thread/event could duplicate (the
 * dedupe lived only in app code, ingest.ts). Add a partial UNIQUE index scoped
 * to the external source kinds.
 *
 * NOTE: deliberately NOT a blanket UNIQUE(source_kind, source_ref). The pattern-
 * placement marker (PR-C+, Phase D) reuses source_kind='pattern' + source_ref=
 * <patternId> across *many* placed blocks, so a blanket unique would break it.
 * Scoping to ('gmail','gcal') matches the actual intent (external round-trips).
 *
 * The recurrence-instance guard the review also asked for —
 * UNIQUE(recurrence_parent_id, occurrence_date) — already exists as
 * `ux_task_occurrence` since migration 0008; not re-added here.
 *
 * Dedupes any existing collisions (keep the lowest id) before creating the
 * index, so the CREATE can't fail on dirty data. Additive + idempotent.
 */
export function up(db: Database): void {
  for (const table of ['tasks', 'time_blocks']) {
    db.exec(`
      DELETE FROM ${table} WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY source_kind, source_ref ORDER BY id) AS rn
            FROM ${table}
           WHERE source_kind IN ('gmail','gcal') AND source_ref IS NOT NULL
        ) WHERE rn > 1
      );
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_ingest_source
        ON ${table}(source_kind, source_ref)
        WHERE source_kind IN ('gmail','gcal') AND source_ref IS NOT NULL;
    `);
  }
}
