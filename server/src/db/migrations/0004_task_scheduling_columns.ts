import type { Database } from 'better-sqlite3';

export const id = '0004_task_scheduling_columns';

/**
 * Separate "when I intend to work it" from "hard deadline":
 *   scheduled_for — local YYYY-MM-DD (intent; like a Phase-A day key)
 *   defer_until   — UTC ISO instant (hide from the today-set until then)
 * due_at keeps its column but is now read strictly as a hard deadline.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has('scheduled_for')) db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_for TEXT`);
  if (!has('defer_until')) db.exec(`ALTER TABLE tasks ADD COLUMN defer_until TEXT`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_sched
     ON tasks(owner_id, status, scheduled_for)`
  );
}
