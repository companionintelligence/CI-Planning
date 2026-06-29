import type { Database } from 'better-sqlite3';

export const id = '0075_block_recurrence_exdates';

/**
 * Adds `recurrence_exdates` to `time_blocks` (JSON `string[]` of skipped local
 * YYYY-MM-DD), mirroring `tasks.recurrence_exdates` (0008). Lets a user delete a
 * single materialized instance of a recurring Time Block durably: the DELETE route
 * appends the occurrence's day here and `ensureRecurringBlocksForRange` honours it,
 * so the instance isn't re-materialized on the next read. Without it, recurring
 * blocks with no tasks inside (e.g. a "Deep-focus" block) regenerated on every read
 * and could not be removed.
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('recurrence_exdates')) {
    db.exec(`ALTER TABLE time_blocks ADD COLUMN recurrence_exdates TEXT`);
  }
}
