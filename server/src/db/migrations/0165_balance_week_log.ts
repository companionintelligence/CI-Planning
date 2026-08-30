import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0165_balance_week_log';

/**
 * Balance-targets wave (bal-6) — the durable-evidence stage for the wave. A weekly
 * batch job (`snapshot_balance`, seeded below) freezes each completed week's
 * target / scheduled / timed numbers per life dimension into this append-only,
 * owner-scoped log. The live bias (tickets 3/4) reads the *instruction*
 * (`life_priorities` + the current week's calendar, via `services/balance-budget.ts`);
 * this table is the *history* any future learning reads — the same
 * evidence/rollup/measurement split the house pattern
 * (`services/classification-learning.ts`) establishes, applied here to just the
 * evidence tier (no rollup/measurement tables — nothing reads this log in this wave;
 * ticket 7 adds the readout).
 *
 * NOT gated by `balance_bias_enabled` — history accrues regardless, exactly like
 * `classification_log` accrues with learning surfaces off. NOT backfilled — first rows
 * appear on the first Monday after merge; past calendars mutate and `life_priorities`
 * has no history, so a missed week can never be recovered. NOT updated once written —
 * `INSERT OR IGNORE` only (first-freeze-wins, the `freeze_stars` doctrine: a frozen
 * week never recomputes).
 *
 * Deliberately NOT mirrored in schema.ts: `schema-parity.test.ts` asserts only modelled
 * tables, and nothing app-side reads this via Drizzle — the same doctrine as the
 * close-loop wave's log tables (`possible_outcome_log` et al., 0157: "None of these are
 * mirrored in schema.ts: like classification_log (0149), triality_weights (0142) and
 * calibration_history (0138), they are read and written through raw SQL only").
 * `category` is bare TEXT, code-enforced (house rule: no CHECK).
 *
 * Also seeds the `snapshot_balance` cron row — Monday 04:40, clear of every cron row
 * merged to origin/main as of this wave (nearest neighbors 03:50/04:10/04:20/05:00
 * Monday) and of G-INT's claimed-on-paper 04:30 Monday (`calibrate_placement`). Runs
 * after the calibrate_* passes — single-GPU serialisation (0150's comment) — even
 * though this job needs no model, so it stays clear of any future job that does.
 * `INSERT OR IGNORE` keeps the seed idempotent across re-runs, same as 0150.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_week_log (
      id                TEXT PRIMARY KEY,             -- newId() (UUIDv7)
      owner_id          TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      week_start        TEXT NOT NULL,                -- owner-local Monday, YYYY-MM-DD
      category          TEXT NOT NULL,                -- life_priorities.category key; bare TEXT, code-enforced (house rule: no CHECK)
      target_hours      INTEGER NOT NULL,             -- life_priorities.target_hours_per_week at snapshot time
      scheduled_minutes INTEGER NOT NULL,             -- ticket 1's calendar measure for that week
      timed_minutes     INTEGER NOT NULL,             -- finished time_entries via task categories (SQL_CATEGORY_ENTRIES shape, triality-vector.ts:194)
      created_at        TEXT NOT NULL,                -- ISO-8601 UTC, stamped in code (new Date().toISOString())
      UNIQUE(owner_id, week_start, category)
      -- The UNIQUE(owner_id, week_start, category) index also serves the owner-scoped
      -- recent-weeks read (leftmost owner_id), so no separate index — the 0127 pattern.
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'snapshot_balance', 'snapshot_balance', '40 4 * * 1');
}
