import type { Database } from 'better-sqlite3';

export const id = '0127_life_priorities';

/**
 * Life priorities — ported from the life-priorities-wizard feature and adapted to
 * multi-tenant main. One row per (owner, category) capturing a self-audit: current
 * `satisfaction` (1–10), `importance` (1–10), and a `target_hours_per_week` focus.
 * Owner-scoped (the pre-multi-tenant original was global); the Priorities Wizard
 * upserts by (owner_id, category). Additive CREATE TABLE + INDEX, idempotent,
 * forward-only — mirrors 0109_copy_history.ts.
 *
 * Categories are a fixed client-side set (health | career | relationships | growth |
 * leisure | finance); `category` is a plain TEXT key, not a FK to tags.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS life_priorities (
      id                    TEXT PRIMARY KEY,
      owner_id              TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      category              TEXT NOT NULL,
      satisfaction          INTEGER NOT NULL DEFAULT 5,
      importance            INTEGER NOT NULL DEFAULT 5,
      target_hours_per_week INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- The UNIQUE(owner_id, category) index also serves owner-scoped lookups
      -- (owner_id is its leftmost column), so no separate owner index is needed.
      UNIQUE(owner_id, category)
    );
  `);
}
