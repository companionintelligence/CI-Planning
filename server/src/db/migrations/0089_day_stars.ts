import type { Database } from 'better-sqlite3';

export const id = '0089_day_stars';

/**
 * Phase O · O2 — the day_stars cache.
 *
 * One row per (owner, date) holding the FROZEN five-star booleans + total. The
 * nightly freeze job snapshots computeStars() into this table for the day that
 * just ended; a frozen day never recomputes, so editing a past task or note
 * can't retroactively add or strip a star. GET /api/stars returns the frozen row
 * when present, else computes live.
 *
 * Additive + idempotent (IF NOT EXISTS).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_stars (
      owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      date           TEXT NOT NULL,           -- local YYYY-MM-DD
      star_objective INTEGER NOT NULL DEFAULT 0,
      star_habits    INTEGER NOT NULL DEFAULT 0,
      star_tasks     INTEGER NOT NULL DEFAULT 0,
      star_bonus     INTEGER NOT NULL DEFAULT 0,
      star_note      INTEGER NOT NULL DEFAULT 0,
      total          INTEGER NOT NULL DEFAULT 0,
      frozen_at      TEXT NOT NULL,
      PRIMARY KEY (owner_id, date)
    );
  `);
}
