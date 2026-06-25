import type { Database } from 'better-sqlite3';

export const id = '0062_daily_plan';

/**
 * Phase M §0 — durable day plan.
 *
 * Stores the LLM-authored (or deterministic-fallback) ordering for a given
 * owner/day: the frozen sequence the deterministic placer and every subsequent
 * reflow will read. Written ONCE per (owner, date) by `authorPlanOrder`; never
 * mutated by placement or reflow — only `block_id` is linked back on placement
 * and rationale is written at authoring time (A3).
 *
 * Columns:
 *   position  — 0-based slot in today's plan (the frozen order). Tasks with no
 *               row fall back to flight_plan.position in selectedStaged().
 *   rationale — one-line "why now" (A3); null until A3 ships.
 *   source    — 'llm' when the loop passed its rubric; 'deterministic' on
 *               fallback (toggle off, Ollama down, escape hatch).
 *   block_id  — linked on placement; null until placeFlightPlan runs. Used by
 *               the block-detail view to display the rationale (A3).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_plan (
      owner_id   TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      date       TEXT    NOT NULL,
      task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      rationale  TEXT,
      source     TEXT    NOT NULL DEFAULT 'deterministic',
      block_id   TEXT    REFERENCES time_blocks(id) ON DELETE SET NULL,
      PRIMARY KEY (owner_id, date, task_id)
    );
    CREATE INDEX IF NOT EXISTS ix_daily_plan_owner_date
      ON daily_plan(owner_id, date, position);
  `);
}
