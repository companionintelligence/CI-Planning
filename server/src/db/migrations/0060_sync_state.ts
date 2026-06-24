import type { Database } from 'better-sqlite3';

export const id = '0060_sync_state';

/**
 * Wave 0 (WP1) — per-(owner, provider, account, resource) sync cursor store.
 *
 * `resource` distinguishes the cursor kind, e.g. 'calendar_synctoken' (Google Calendar
 * incremental syncToken) vs 'gmail_history' (Gmail historyId). `cursor` is the opaque
 * provider token to resume from; `window_from`/`window_to` record the bounded window a
 * full (non-incremental) sync covered. UNIQUE(owner_id, provider, account, resource)
 * makes the upsert key explicit — one cursor row per resource per account.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES owners(id),
      provider    TEXT NOT NULL,
      account     TEXT NOT NULL,
      resource    TEXT NOT NULL,   -- 'calendar_synctoken' | 'gmail_history' | ...
      cursor      TEXT,            -- opaque provider resume token
      window_from TEXT,
      window_to   TEXT,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner_id, provider, account, resource)
    );
    CREATE INDEX IF NOT EXISTS ix_sync_state_owner ON sync_state(owner_id);
  `);
}
