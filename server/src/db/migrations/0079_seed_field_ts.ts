import type { Database } from 'better-sqlite3';

export const id = '0079_seed_field_ts';

/**
 * Phase L (gap 4): seed `field_ts` for pre-migration rows that have never
 * been touched by applyOp or stampRow.
 *
 * Without this, the first sync op on any pre-0076 row wins unconditionally
 * because `op.clientTs >= (fieldTs[field] ?? '')` is always true when
 * field_ts is NULL (parsed as {}, so the per-field stamp is undefined → '').
 *
 * Seeding strategy:
 *   - Use `updated_at` when available (set by stampRow on online PATCHes).
 *     Any op with an older clientTs will correctly lose the LWW comparison.
 *   - Fall back to the epoch string '1970-01-01T00:00:00.000Z' when updated_at
 *     is NULL (rows untouched since 0076). This preserves the original
 *     "first op wins" behaviour for those rows while stamping the field so
 *     the NEXT LWW comparison has a real anchor. It does NOT retroactively
 *     reject legitimate offline ops that were queued before this migration ran.
 *
 * The field lists exactly match the TASK_FIELDS / BLOCK_FIELDS allowlists in
 * server/src/sync/apply.ts so only syncable fields get a stamp.
 */
export function up(db: Database): void {
  const EPOCH = '1970-01-01T00:00:00.000Z';

  // Stamp for tasks — 13 whitelisted fields.
  db.prepare(`
    UPDATE tasks
    SET field_ts = json_object(
      'title',              COALESCE(updated_at, ?),
      'description',        COALESCE(updated_at, ?),
      'notes',              COALESCE(updated_at, ?),
      'due_at',             COALESCE(updated_at, ?),
      'scheduled_for',      COALESCE(updated_at, ?),
      'defer_until',        COALESCE(updated_at, ?),
      'task_time',          COALESCE(updated_at, ?),
      'estimated_minutes',  COALESCE(updated_at, ?),
      'priority',           COALESCE(updated_at, ?),
      'status',             COALESCE(updated_at, ?),
      'completed_at',       COALESCE(updated_at, ?),
      'parent_id',          COALESCE(updated_at, ?),
      'subtype',            COALESCE(updated_at, ?)
    )
    WHERE field_ts IS NULL
  `).run(EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH);

  // Stamp for time_blocks — 14 whitelisted fields.
  db.prepare(`
    UPDATE time_blocks
    SET field_ts = json_object(
      'title',            COALESCE(updated_at, ?),
      'start_at',         COALESCE(updated_at, ?),
      'end_at',           COALESCE(updated_at, ?),
      'is_locked',        COALESCE(updated_at, ?),
      'status',           COALESCE(updated_at, ?),
      'block_kind',       COALESCE(updated_at, ?),
      'tag',              COALESCE(updated_at, ?),
      'block_type',       COALESCE(updated_at, ?),
      'goal_start_date',  COALESCE(updated_at, ?),
      'duration_minutes', COALESCE(updated_at, ?),
      'note',             COALESCE(updated_at, ?),
      'all_day',          COALESCE(updated_at, ?),
      'parent_block_id',  COALESCE(updated_at, ?),
      'category_id',      COALESCE(updated_at, ?)
    )
    WHERE field_ts IS NULL
  `).run(EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH, EPOCH);
}
