import type { Database } from 'better-sqlite3';

export const id = '0166_placement_evidence';

/**
 * Placement-learning wave, ticket 1 — the storage the loop needs. Three tables in the
 * same three-role split `classification_log` / `classification_exemplars` /
 * `classification_accuracy` (0149) already established:
 *
 *  - `placement_log` is DURABLE, APPEND-ONLY EVIDENCE. One row per engine placement,
 *    opened when the scheduler places and closed if the owner moves it (ticket 2 opens
 *    it, ticket 3 closes it — this ticket only lands the table).
 *  - `placement_preferences` is a REGENERABLE ROLLUP — the learned hour band `pickGap`
 *    reads (ticket 5), rebuilt wholesale per owner by `calibrate_placement` (ticket 4).
 *  - `placement_survival` is the MEASUREMENT — one reading per owner per day of whether
 *    placements are starting to survive the day untouched (ticket 6).
 *
 * `candidates` is the load-bearing column on the log: the menu of free gaps `pickGap`
 * weighed before choosing, as a JSON array. `pickGap` already computes this list and
 * throws it away microseconds later — without it, "moved 9am -> 7pm" cannot be told
 * apart from "7pm was already full", and the batch could never separate a preference
 * from a constraint.
 *
 * `block_id`/`task_id` are deliberately NOT foreign keys, and there is no FK from the log
 * to `time_blocks` or `tasks` at all: the evidence must outlive both. `reflow()` deletes
 * and recreates auto blocks on every run, and `resetDb()` clears both tables wholesale —
 * a cascade would erase the corpus continuously, in production and between test files.
 *
 * `fit = 0` rows (pickGap fell back to the largest gap and truncated) are a forced
 * placement, not a choice — they express no preference, so the batch (ticket 4) excludes
 * them from both sides of the ledger. `fit` is recorded here so that exclusion is
 * possible later; this ticket writes no rows at all.
 *
 * `field`-style enums (`slot_key`, `fit`, `biased`) are bare TEXT/INTEGER enforced in
 * code, not CHECK constraints — repo convention (0140, 0142, 0149, 0151). None of these
 * three tables are mirrored in schema.ts, exactly like the 0149 trio, `triality_weights`
 * (0142) and `calibration_history` (0138): raw SQL only, read and written through it.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS placement_log (
      id              TEXT PRIMARY KEY,
      owner_id        TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      -- Nullable and deliberately NOT foreign keys: the evidence outlives the block and the
      -- task. reflow() deletes and recreates auto blocks on every run, and resetDb() clears
      -- both tables wholesale — a cascade would erase the corpus continuously.
      block_id        TEXT,
      task_id         TEXT,
      -- The learned grain: the task's level-1 direction tag NAME ('work' | 'home' |
      -- 'community' | ...), or the literal '(none)'. A name, never a tag id — a renamed or
      -- deleted tag must not orphan the evidence.
      slot_key        TEXT    NOT NULL,
      -- The Auto run that made this placement (0052); NULL outside a run. No current
      -- reader (flagged in code review) — kept anyway, unlike this table's other
      -- write-only column that was cut (this one's dropped p50_hour sibling): this is
      -- denormalized provenance time_blocks.auto_run_id can't substitute for once the
      -- block is gone, since this log deliberately outlives it.
      auto_run_id     TEXT,
      -- What the scheduler chose.
      chosen_start_at TEXT    NOT NULL,
      chosen_end_at   TEXT    NOT NULL,
      chosen_hour     INTEGER NOT NULL,  -- 0-23, OWNER-LOCAL hour of chosen_start_at
      -- 1 when pickGap found a gap that fully fit; 0 when it fell back to the largest gap and
      -- truncated. A truncated placement is forced, not chosen, so it expresses no preference
      -- and the batch excludes it from both sides of the ledger.
      fit             INTEGER NOT NULL,
      -- THE MENU: the free gaps the scheduler weighed, as a JSON array
      -- [{"s":<epoch ms>,"e":<epoch ms>,"c":<cursor epoch ms>}], day order, capped in code.
      -- This is what makes a correction learnable at all.
      candidates      TEXT    NOT NULL,
      -- Where the owner moved it. NULL until they do — the twin of
      -- classification_log.final_value.
      moved_start_at  TEXT,
      moved_end_at    TEXT,
      moved_hour      INTEGER,           -- 0-23, owner-local hour of moved_start_at
      placed_at       TEXT    NOT NULL,
      moved_at        TEXT,
      local_date      TEXT    NOT NULL   -- 'YYYY-MM-DD', owner-local day of placed_at
    );
    -- The learning read: one owner's rows over a date window, grouped by key in
    -- application code (calibratePlacement reads every slot_key for the owner in one
    -- pass, then groups). local_date leads slot_key so the batch can seek the window
    -- cutoff and get ORDER BY local_date, id for free, instead of an owner-wide scan
    -- plus a temp-sort that a slot_key-first index would force.
    CREATE INDEX IF NOT EXISTS ix_placement_log_owner_date
      ON placement_log(owner_id, local_date, id);
    -- The correction read: the still-open row for a block, which updateBlock closes on a drag.
    CREATE INDEX IF NOT EXISTS ix_placement_log_block
      ON placement_log(block_id);

    CREATE TABLE IF NOT EXISTS placement_preferences (
      owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      slot_key      TEXT    NOT NULL,
      -- Owner-local hours (0-23, fractional) of where corrections LANDED — a BAND, not a
      -- point, so the bias is neutral across a span instead of pulling everything to one
      -- hour. No p50_hour: unlike estimate_calibration/calibration_history (0138), which
      -- this idiom otherwise mirrors, nothing here ever reads a midpoint back — only the
      -- band edges bias placementScorer. Found unused in code review; not carried over.
      p25_hour      REAL    NOT NULL,
      p75_hour      REAL    NOT NULL,
      corrections   INTEGER NOT NULL,   -- corrected rows the band was built from
      sample_count  INTEGER NOT NULL,   -- decided rows (corrected + accepted) for the key
      computed_date TEXT    NOT NULL,   -- 'YYYY-MM-DD', owner-local day of the run
      PRIMARY KEY (owner_id, slot_key)
    );

    CREATE TABLE IF NOT EXISTS placement_survival (
      owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      computed_date TEXT    NOT NULL,   -- 'YYYY-MM-DD', owner-local day of the run
      -- A recorded PARAMETER of the reading (the peer of classification_accuracy.held_out),
      -- not a tunable: nothing reads it back to change behaviour.
      period_days   INTEGER NOT NULL,
      decided       INTEGER NOT NULL,   -- rows that reached an outcome in the period
      accepted      INTEGER NOT NULL,   -- placements whose slot arrived and were never moved
      corrected     INTEGER NOT NULL,
      -- Stored rather than derived, and NULL when decided = 0, so an unmeasured period is
      -- distinguishable from one that scored 0%. The trend must draw a GAP, never a zero.
      survival_rate REAL,
      keys_learned  INTEGER NOT NULL,   -- placement_preferences rows for the owner after the run
      biased        INTEGER NOT NULL,   -- 0 | 1: was gap choice biased during the period
      PRIMARY KEY (owner_id, computed_date)
    );
  `);
}
