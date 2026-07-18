import type { Database } from 'better-sqlite3';

export const id = '0131_planning_sessions';

/**
 * FTUE · T1 (#337) — the planning-session log.
 *
 * One row per "Plan my week" session. The whole conversation lives on the row as a
 * single JSON `transcript` array; there is deliberately NO per-turn events table and
 * no child table of this one. T2+ write here, the Logs tab (T6) reads.
 *
 * `entry_branch` and `status` are code-enforced enums, NOT CHECK constraints — the
 * service validates and the route maps a bad value to 422, which keeps adding a
 * branch a code change rather than a migration.
 *
 * Like copy_history / audit_log this is non-noun operational state: regenerable chat
 * logs, not user-authored domain data.
 *
 * Slot note: the T1 draft was authored at head 0126 and reserved `0127`, but that slot
 * went to `life_priorities` (#356) while this ticket sat. 0131 was the next free
 * integer with no open PR claiming it.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS planning_sessions (
      id            TEXT PRIMARY KEY,
      owner_id      TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      started_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at      TEXT,
      entry_branch  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      llm_used      INTEGER NOT NULL DEFAULT 0,
      transcript    TEXT NOT NULL DEFAULT '[]',
      summary       TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- The Logs tab lists one owner's sessions newest-first; this index serves it.
    CREATE INDEX IF NOT EXISTS ix_planning_sessions_owner
      ON planning_sessions (owner_id, started_at);
  `);
}
