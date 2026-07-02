import type { Database } from 'better-sqlite3';

export const id = '0096_daily_recap';
// Merges two tables into one (create + backfill + drop) — toggles foreign_keys
// OFF for the swap, so it runs outside the runner's auto-transaction. CON-1.
export const manual = true;

/**
 * S1-B (schema consolidation) — co-locate `daily_summaries` + `day_stars` into a
 * single `daily_recap` table keyed `(owner_id, date)`. Both answer "how did this
 * day go" at the same grain; neither joined the other; each had one independent
 * writer touching only its own columns.
 *
 * The one semantic shift: columns that were NOT NULL in their own table become
 * NULLABLE here, because a row can legitimately hold only one writer's data (a
 * day with stars frozen but no briefing yet, or vice-versa). Writers use partial,
 * column-scoped upserts so they never clobber each other's group.
 *
 * IMMUTABILITY: `frozen_at` marks a frozen star row. The freeze job (jobs/
 * freeze-stars.ts) keys first-freeze-wins on `frozen_at IS NOT NULL` (NOT on row
 * existence — a summary may have created the row first) and writes with a
 * `WHERE daily_recap.frozen_at IS NULL` guarded upsert. GET /api/stars reads only
 * rows where `frozen_at IS NOT NULL` as frozen, else computes live.
 *
 * Both source tables are LEAF (no inbound FKs), so the drop is safe; FK is toggled
 * OFF only as the standard rebuild posture. Forward-only + idempotent (guards on
 * `daily_recap` already existing). Assumes 0095 already dropped `plan_outcomes`.
 */
export function up(db: Database): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='daily_recap'`)
    .get();
  if (exists) return; // already merged — re-run safety.

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE daily_recap (
          owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
          date           TEXT NOT NULL,
          -- summary group (from daily_summaries; mutable content cache)
          prose          TEXT,
          stats          TEXT,
          focus          TEXT,
          llm            INTEGER,
          inputs_hash    TEXT,
          -- stars group (from day_stars; immutable once frozen_at is set)
          star_objective INTEGER,
          star_habits    INTEGER,
          star_tasks     INTEGER,
          star_bonus     INTEGER,
          star_note      INTEGER,
          total          INTEGER,
          frozen_at      TEXT,
          created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at     TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (owner_id, date)
        );

        -- Backfill: union the distinct (owner, date) keys across both sources,
        -- LEFT JOIN each so sparse days (only one group populated) survive.
        INSERT INTO daily_recap (
          owner_id, date, prose, stats, focus, llm, inputs_hash,
          star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at,
          created_at, updated_at
        )
          SELECT k.owner_id, k.date,
                 s.prose, s.stats, s.focus, s.llm, s.inputs_hash,
                 st.star_objective, st.star_habits, st.star_tasks, st.star_bonus, st.star_note, st.total, st.frozen_at,
                 COALESCE(s.created_at, CURRENT_TIMESTAMP), COALESCE(s.updated_at, CURRENT_TIMESTAMP)
          FROM (
            SELECT owner_id, date FROM daily_summaries
            UNION
            SELECT owner_id, date FROM day_stars
          ) k
          LEFT JOIN daily_summaries s ON s.owner_id = k.owner_id AND s.date = k.date
          LEFT JOIN day_stars       st ON st.owner_id = k.owner_id AND st.date = k.date;

        DROP TABLE daily_summaries;
        DROP TABLE day_stars;
      `);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
