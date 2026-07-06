import type { Database } from 'better-sqlite3';

export const id = '0115_possible_tasks_proposed_start';

/**
 * Phase AB · AB2 — memory suggestions mirror the event, so the inbox must carry the
 * event's START intent (not just a due date; the AA gap stuffed event starts into
 * proposed_due_at and placement dumped everything on "today"):
 *
 *  - `proposed_scheduled_for` TEXT (YYYY-MM-DD, event day in the OWNER's timezone)
 *  - `proposed_task_time`     TEXT (HH:MM wall-clock in the owner's timezone)
 *
 * Both nullable, appended LAST (plain ADD COLUMN keeps physical order — the
 * schema-shape characterization golden captures PRAGMA order; regenerated in this
 * PR). Promote copies them to tasks.scheduled_for / task_time, then AB1's
 * placeStartAnchoredTask lands the block at the event's exact time on its day.
 *
 * Idempotent: per-column exists guards, so a re-run is a no-op.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(possible_tasks)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes('proposed_scheduled_for')) {
    db.exec(`ALTER TABLE possible_tasks ADD COLUMN proposed_scheduled_for TEXT;`);
  }
  if (!cols.includes('proposed_task_time')) {
    db.exec(`ALTER TABLE possible_tasks ADD COLUMN proposed_task_time TEXT;`);
  }
}
