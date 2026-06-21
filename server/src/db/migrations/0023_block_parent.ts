import type { Database } from 'better-sqlite3';

export const id = '0023_block_parent';

/**
 * Plan-as-container (PR-C). A task block scheduled into a Plan (a
 * `block_kind='timeblock'`, `block_type='plan'` container) is formally a *member*
 * of it via the new self-referential `time_blocks.parent_block_id`. Moving the
 * Plan — or any member — moves the whole group together (see the move-group route).
 *
 * The FK is **ON DELETE SET NULL**: deleting a Plan detaches its members (they
 * survive as loose task blocks) rather than cascading them away. `foreign_keys`
 * is ON connection-wide (db/index.ts), so the action fires automatically. Same
 * shape as the existing `time_entries.block_id` set-null reference.
 *
 * Additive + idempotent. SQLite permits ADD COLUMN with a REFERENCES clause as
 * long as the new column defaults to NULL (it does).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('parent_block_id')) {
    db.exec(`ALTER TABLE time_blocks ADD COLUMN parent_block_id INTEGER REFERENCES time_blocks(id) ON DELETE SET NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS ix_time_blocks_parent ON time_blocks(parent_block_id)`);
  }
}
