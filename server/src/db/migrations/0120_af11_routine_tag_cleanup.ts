import type { Database } from 'better-sqlite3';

export const id = '0120_af11_routine_tag_cleanup';

/**
 * AF-11 Slice 6 (Decision D3) — one-shot legacy routine-tag cleanup.
 *
 * Routines no longer author tags: their displayed tags are DERIVED at read time as
 * the union of their member tasks' tags (D2 — see services/tags.ts
 * routineDerivedTagsByIds). The old authored state was denormalized twice:
 * `patterns.tag` (a comma-joinable string) + mirrored `entity_tags` rows with
 * entity_kind='routine' (CON-3). Both are non-load-bearing post-Slice-4 (the write
 * paths ignore incoming tags and the readers consume the derived union), so this
 * clears the stale authored rows rather than leaving split-brain display data.
 *
 * Idempotent by construction (UPDATE→NULL / DELETE re-run to no-ops). Guarded on the
 * `patterns.tag` column existing so a historical replay against a reshaped table
 * can't throw (the T-phase col-exists lesson); entity_tags exists since 0033, before
 * any state this migration can run against, but gets the same guard for symmetry.
 *
 * NOTE (renumber-at-merge, RESOLVED): numbered 0120 assuming the AF-11 slices-1-3
 * sibling lane (claude/af11-task-tag-split) would land 0119 first. This file merged
 * first instead, so the sibling renumbered its task-intention level move to 0121;
 * 0119 stays unused. The bodies are order-independent (different tables: this touches
 * patterns + entity_kind='routine' rows only; 0121 touches entity_kind='task' rows).
 */
export function up(db: Database): void {
  const patternsHasTag = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('patterns') WHERE name = 'tag'`).get() as { n: number }).n > 0;
  if (patternsHasTag) {
    db.prepare(`UPDATE patterns SET tag = NULL WHERE tag IS NOT NULL`).run();
  }
  const hasEntityTags = (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'entity_tags'`).get() as { n: number }).n > 0;
  if (hasEntityTags) {
    db.prepare(`DELETE FROM entity_tags WHERE entity_kind = 'routine'`).run();
  }
}
