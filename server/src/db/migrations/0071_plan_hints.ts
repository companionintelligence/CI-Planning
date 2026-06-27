import type { Database } from 'better-sqlite3';

export const id = '0071_plan_hints';

/**
 * Phase M A4 — persist natural-language planning HINTS so a later autoplan run can
 * enforce them. `POST /api/plan/instruct` parses free text into time PINS (already
 * applied as locked blocks) and tag HINTS; the hints had no carrier, so they were
 * returned but never enforced. This is that carrier — transient, day-scoped:
 *
 *   kind  — 'tag_before' | 'tag_after' (a clock window for the tag) | 'batch'
 *   tag   — an existing tag name (validated at parse time)
 *   time  — 'HH:MM' wall-clock for before/after; NULL for batch
 *
 * Read by `placeFlightPlan` (transient per-tag day-windows, like direction windows)
 * and by `authorPlanOrder` (a soft constraint line in the ordering prompt). Hints
 * accumulate across instructs for the same day; the unique index (time NULLs folded
 * to '') makes a repeated instruct idempotent.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_hints (
      id         TEXT    NOT NULL PRIMARY KEY,
      owner_id   TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      date       TEXT    NOT NULL,
      kind       TEXT    NOT NULL,
      tag        TEXT    NOT NULL,
      time       TEXT,
      created_at TEXT    DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS ix_plan_hints_owner_date ON plan_hints(owner_id, date);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_hints_dedupe
      ON plan_hints(owner_id, date, kind, tag, COALESCE(time, ''));
  `);
}
