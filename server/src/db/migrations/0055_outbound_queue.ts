import type { Database } from 'better-sqlite3';

export const id = '0055_outbound_queue';

/**
 * Phase J (PR3) — outbound sync queue. Each row marks a local block that needs
 * to be pushed (created or updated) to a provider on the next sync cycle.
 * UNIQUE(block_id, provider, account): re-enqueueing on PATCH just refreshes
 * created_at; the sync job processes each row once then deletes it.
 * ON DELETE CASCADE on block_id: deleting a block auto-removes its queue entry.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_queue (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL REFERENCES owners(id),
      block_id   TEXT NOT NULL REFERENCES time_blocks(id) ON DELETE CASCADE,
      provider   TEXT NOT NULL,
      account    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(block_id, provider, account)
    );
    CREATE INDEX IF NOT EXISTS ix_outbound_queue_owner ON outbound_queue(owner_id, provider, account);
  `);
}
