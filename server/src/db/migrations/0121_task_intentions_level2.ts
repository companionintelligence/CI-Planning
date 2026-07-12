import type { Database } from 'better-sqlite3';

export const id = '0121_task_intentions_level2';

/**
 * AF-11 Slice 3 (renumbered 0119→0121 at merge; 0120 routine-tag-cleanup landed first) — tasks adopt the split tag shape (docs/AF11-tag-unification.md).
 *
 * Move every task's INTENTION tags from entity_tags level 1 to level 2, so the
 * task model matches timeblocks: one primary DIRECTION at level 1 + N intentions
 * at level 2. All pre-AF-11 task data has intentions at level 1 (the 0033 backfill
 * plus the flat client write path — no code ever wrote a task intention at L2), and
 * a mixed old/new state is split-brain for scheduling and filters, hence a one-shot
 * migration rather than normalize-on-edit.
 *
 * Safety:
 *  - PK-safe: entity_tags' PRIMARY KEY is (entity_kind, entity_id, tag_id) — level
 *    is NOT in the key, so this UPDATE can never collide two rows.
 *  - Owner-safe: tag ids are owner-unique (UNIQUE(owner_id, name) since T2), so the
 *    kind subquery classifies each association by its own owner's taxonomy.
 *  - Direction tags stay at level 1 (kind='intention' filter); block/routine rows
 *    are untouched (entity_kind='task' filter).
 *  - Idempotent: a re-run matches zero rows (nothing is at task-L1-intention
 *    anymore). Precedent for kind-aware reclassification: 0036.
 *
 * Ships atomically with the Slice-1 reader compensation (L1 ∪ L2 matching in
 * ?tag= / autoplan Pass 1 / hint windows / day-authoring) and the Slice-2 client
 * split shape — never apply this without those readers (R1/R2: intention filters
 * and Plan matching would silently die).
 */
export function up(db: Database): void {
  db.exec(`
    UPDATE entity_tags SET level = 2
     WHERE entity_kind = 'task' AND level = 1
       AND tag_id IN (SELECT id FROM tags WHERE kind = 'intention')
  `);
}
