import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0044_notifications';

/**
 * Phase H — Notifications + Web Push.
 *
 * `push_subscriptions` — one row per browser push endpoint (owner-scoped).
 * `reminders` — a single `fire_at` per row with exactly one target (task XOR block,
 *   enforced by a CHECK). status: pending | fired | snoozed | cancelled.
 *
 * Also seeds the 1-minute `fire_reminders` cron; the existing `startCronJobs()` loop
 * picks it up (no croner change). Additive + idempotent.
 *
 * CON-1: ids are TEXT UUIDv7. The `scheduled_jobs` seed MUST supply `id` — unlike the
 * pre-CON-1 seeds in 0003/0011 (which ran when the column was INTEGER AUTOINCREMENT),
 * a post-CON-1 insert has no default, so we mint one via `newId()` (matches 0036/0037).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL REFERENCES owners(id),
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS ix_push_subscriptions_owner ON push_subscriptions(owner_id);

    CREATE TABLE IF NOT EXISTS reminders (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL REFERENCES owners(id),
      task_id    TEXT REFERENCES tasks(id)       ON DELETE CASCADE,
      block_id   TEXT REFERENCES time_blocks(id) ON DELETE CASCADE,
      fire_at    TEXT NOT NULL,                   -- UTC ISO; tz-correct via lib/tz
      status     TEXT NOT NULL DEFAULT 'pending', -- pending | fired | snoozed | cancelled
      fired_at   TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((task_id IS NULL) <> (block_id IS NULL))  -- exactly one target
    );
    CREATE INDEX IF NOT EXISTS ix_reminders_due ON reminders(status, fire_at);
  `);

  // Seed the dispatcher cron (1-minute tick). INSERT OR IGNORE on the UNIQUE name
  // keeps it idempotent; id is minted here (no autoincrement default post-CON-1).
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`
  ).run(newId(), 'fire_reminders', 'fire_reminders', '* * * * *');
}
