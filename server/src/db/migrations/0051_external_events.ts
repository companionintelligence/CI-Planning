import type { Database } from 'better-sqlite3';

export const id = '0051_external_events';

/**
 * Phase J (PR1) — sync identity map. Each row links a provider event to a local
 * time_blocks row. Conflict identity is (provider, account, external_id) + etag;
 * embeddings are never used here — the sync layer must be exact and deterministic.
 *
 * ON DELETE CASCADE on block_id: removing a block cleans up its sync record.
 * direction 'inbound'  = provider event mirrored as a read-only meeting block.
 * direction 'outbound' = local task-block pushed to the provider calendar.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_events (
      id             TEXT PRIMARY KEY,
      owner_id       TEXT NOT NULL REFERENCES owners(id),
      provider       TEXT NOT NULL,  -- 'google' | 'outlook' | 'icloud'
      account        TEXT NOT NULL,  -- provider account identifier
      external_id    TEXT NOT NULL,  -- provider's immutable event id
      block_id       TEXT REFERENCES time_blocks(id) ON DELETE CASCADE,
      etag           TEXT,           -- opaque version token from provider; NULL = unknown
      direction      TEXT NOT NULL DEFAULT 'inbound',
      last_synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(provider, account, external_id)
    );
    CREATE INDEX IF NOT EXISTS ix_external_events_block ON external_events(block_id);
    CREATE INDEX IF NOT EXISTS ix_external_events_owner ON external_events(owner_id, provider, account);
  `);
}
