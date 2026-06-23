import type { Database } from 'better-sqlite3';

export const id = '0045_reminder_source';

/**
 * Phase H (b): mark a reminder's origin so auto-derivation can cleanly replace its
 * OWN rows without clobbering explicitly-created (manual) ones. `syncTaskReminders`
 * deletes `source='auto'` rows for a task and re-derives them from the owner's
 * Reminder Defaults; the explicit POST /api/reminders path keeps the 'manual' default.
 * Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(reminders)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('source')) {
    db.exec(`ALTER TABLE reminders ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
  }
}
