import type { Database } from 'better-sqlite3';

export const id = '0067_replan_suggestions';

/**
 * Phase M B4 — make the reactive-reflow nudge survive a SERVER restart (not just a
 * page reload). The outstanding suggestion was an in-memory Map in auto-defense.ts;
 * this persists it. One row per owner (PK owner_id) → "one outstanding per owner,
 * a new day overwrites" via INSERT OR REPLACE.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replan_suggestions (
      owner_id   TEXT    NOT NULL PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
      date       TEXT    NOT NULL,
      reason     TEXT    NOT NULL,
      summary    TEXT    NOT NULL,
      at_risk    INTEGER NOT NULL,
      created_at TEXT    DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
