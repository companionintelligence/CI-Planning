import type { Database } from 'better-sqlite3';

export const id = '0077_sync_events';

/**
 * Append-only log of every SSE event emitted for an owner. Enables
 * `Last-Event-ID` catch-up: a reconnecting client replays exactly the events it
 * missed, in order. Cap the replay window in the SSE route (500 rows) to
 * avoid unbounded catch-up; devices offline longer than the retention window
 * get a `sync:resync` frame telling them to refetch everything.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_events (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id  TEXT    NOT NULL,
      entity    TEXT    NOT NULL DEFAULT '',
      entity_id TEXT    NOT NULL DEFAULT '',
      version   INTEGER,
      event     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      at        TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_events_owner_seq ON sync_events (owner_id, seq);
  `);
}
