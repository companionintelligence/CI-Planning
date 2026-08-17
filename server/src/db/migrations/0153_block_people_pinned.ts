import type { Database } from 'better-sqlite3';

export const id = '0153_block_people_pinned';

/**
 * Lets a task-backed time block say "nobody is on this" (0151 follow-up).
 *
 * A block with no `entity_people` rows of its own INHERITS its task's people — the same
 * own-else-derive rule categories follow, and the right default: re-assigning a task
 * should re-label its blocks with no engine writes.
 *
 * But "no rows" was doing double duty: it meant BOTH "never set, so inherit" AND
 * "deliberately cleared". So removing the last attendee chip from a meeting block wrote
 * an empty set, the inherit rule fired, and the task's people reappeared — the clear
 * silently did nothing. The two states are genuinely different and need two
 * representations.
 *
 * `people_pinned` is that second bit: 0 = inherit (the default, and what every existing
 * block keeps), 1 = this block's own set is authoritative even when empty. Any explicit
 * write to either role sets it; clearing BOTH roles and asking to inherit again resets
 * it. Deliberately a plain flag rather than a sentinel row, so the invariant is legible
 * in the schema instead of hidden in a magic person id.
 *
 * SUPERSEDED BY 0154, which splits this single flag into one per role and drops this
 * column. Kept intact rather than edited because it has already been applied and the
 * runner keys on migration id — an edit here would never re-run. On a fresh database
 * the pair adds this column and immediately drops it; read them together.
 *
 * Idempotent via the B0 addColumn-if-missing pattern.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'people_pinned')) {
    db.exec(`ALTER TABLE time_blocks ADD COLUMN people_pinned INTEGER NOT NULL DEFAULT 0`);
  }
}
