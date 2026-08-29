import type { Database } from 'better-sqlite3';

export const id = '0157_dismissal_evidence';

/**
 * Close-loop wave, ticket 1 — the storage the dismissal-learning loop needs.
 *
 * `possible_tasks` has `created_at` (when a suggestion was made) and `status`, but
 * nothing records WHEN a suggestion was decided: there is no `dismissed_at` today, so
 * nothing reads dismissals back and the extractor keeps proposing the same noise
 * forever. Three tables, in the shape `classification_log` / `classification_exemplars`
 * / `classification_accuracy` (0149) already established — the house pattern this wave
 * copies rather than invents:
 *
 *  - `possible_outcome_log` is DURABLE EVIDENCE. Append-only, one row per decided
 *    suggestion: what the extractor proposed, what the owner did with it, and when.
 *    `decided_at` is the load-bearing column — the learning window, the settling
 *    fence and the rate period all hang off this stamp. `possible_task_id` is
 *    deliberately NOT a foreign key: the evidence outlives the suggestion. That the
 *    owner threw a possible away is a fact about what they consider noise, and
 *    pruning the possible must not delete what it taught (resetDb() clears
 *    possible_tasks wholesale, so a cascade here would erase the corpus between
 *    test files).
 *  - `possible_dismissal_exemplars` is a REGENERABLE ROLLUP — the retrieval index the
 *    extraction prompt reads, rebuilt wholesale per owner by `calibrate_dismissals`
 *    (ticket 3).
 *  - `possible_dismissal_rate` is the MEASUREMENT — one noise-rate reading per owner
 *    per run, so "the loop is working" is a number (ticket 6) rather than a claim.
 *
 * `source_kind` and `outcome` are enforced in code, not by CHECK constraints (repo
 * convention). None of these are mirrored in schema.ts: like classification_log
 * (0149), triality_weights (0142) and calibration_history (0138), they are read and
 * written through raw SQL only. This migration lands three empty tables and nothing
 * else — no service, no reads, no writes (capture is ticket 2; the batch is ticket 3).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS possible_outcome_log (
      id               TEXT PRIMARY KEY,
      owner_id         TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      -- Nullable and deliberately NOT a foreign key: the evidence outlives the suggestion.
      -- That the owner threw this away is a fact about what they consider noise, and pruning
      -- the possible must not delete what it taught. (resetDb() clears possible_tasks
      -- wholesale, so a cascade here would erase the corpus between test files.)
      possible_task_id TEXT,
      source_kind      TEXT,          -- 'gmail' | 'gcal' | 'text'; NULL when the possible had none
      input_text       TEXT NOT NULL, -- what the extractor proposed (raw_title [+ raw_summary])
      outcome          TEXT NOT NULL, -- 'dismissed' | 'promoted'
      -- No SQL default, by design: the service stamps this at the moment of the click.
      -- NOTE the format differs from possible_tasks.created_at (CURRENT_TIMESTAMP,
      -- space-separated) — never compare the two as strings.
      decided_at       TEXT NOT NULL,
      local_date       TEXT NOT NULL  -- 'YYYY-MM-DD', owner-local day it was decided
    );
    -- The learning read: one owner's decided rows over a date window.
    CREATE INDEX IF NOT EXISTS ix_possible_outcome_log_owner_date
      ON possible_outcome_log(owner_id, local_date);
    -- The reversal/dedupe read: every outcome recorded for one suggestion — so a dismissal
    -- later reversed by a promote can be fenced out, and a repeated dismiss collapsed.
    CREATE INDEX IF NOT EXISTS ix_possible_outcome_log_possible
      ON possible_outcome_log(possible_task_id);

    CREATE TABLE IF NOT EXISTS possible_dismissal_exemplars (
      owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      log_id        TEXT    NOT NULL,       -- the possible_outcome_log row it came from
      input_text    TEXT    NOT NULL,
      source_kind   TEXT,
      -- Float32 little-endian, as sqlite-vec wants it. NULL when the run had no embedder:
      -- still a usable exemplar for the priors line, just not retrievable by similarity.
      embedding     BLOB,
      computed_date TEXT    NOT NULL,
      PRIMARY KEY (owner_id, log_id)
    );

    CREATE TABLE IF NOT EXISTS possible_dismissal_rate (
      owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      computed_date TEXT    NOT NULL,       -- 'YYYY-MM-DD', owner-local day of the run
      -- A recorded PARAMETER of the reading (the peer of classification_accuracy.held_out),
      -- not a tunable: nothing reads it back to change behaviour.
      period_days   INTEGER NOT NULL,
      created       INTEGER NOT NULL,       -- suggestions produced in the period
      decided       INTEGER NOT NULL,       -- dismissed + promoted in the period
      dismissed     INTEGER NOT NULL,
      -- Stored rather than derived, and NULL when decided = 0, so an unmeasured period is
      -- distinguishable from one that scored 0%. The trend must never plot unknown as zero.
      rate          REAL,
      exemplars     INTEGER NOT NULL,       -- rollup size at the end of the run
      hinted        INTEGER NOT NULL,       -- 0 | 1: was the extractor hinted during the period
      PRIMARY KEY (owner_id, computed_date)
    );
  `);
}
