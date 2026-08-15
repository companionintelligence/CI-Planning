import type { Database } from 'better-sqlite3';

export const id = '0149_classification_learning';

/**
 * Phase 8 — the parse/classify LLM learns from the owner's corrections.
 *
 * Three tables, in the shape `triality_log` / `triality_weights` already
 * established (services/triality-learning.ts is the house contract):
 *
 *  - `classification_log` is DURABLE EVIDENCE. Append-only, never pruned, the twin
 *    of `triality_log`: what the model said, what the owner settled on, and the text
 *    it was judging. This is the learning history and the only thing that cannot be
 *    recomputed, so nothing else may be the source of truth.
 *  - `classification_exemplars` is a REGENERABLE ROLLUP — the retrieval index the
 *    prompt actually reads, rebuilt wholesale per owner by `calibrate_classification`.
 *    Deleting an owner's rows resets the adaptation without losing the history, so it
 *    is exactly the "reset learning" affordance `triality_weights` has.
 *  - `classification_accuracy` is the MEASUREMENT — one held-out score per field per
 *    run, so "the model got better" is a number in the Jobs view rather than a claim.
 *
 * `field` ('category'|'motivation') and the outcome vocabulary are enforced in code,
 * not by CHECK constraints (repo convention). None of these are mirrored in schema.ts:
 * like calibration_history (0138) and triality_weights (0142), they are read and
 * written through raw SQL only.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS classification_log (
      id           TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      -- Nullable and deliberately NOT a foreign key: the evidence outlives the task.
      -- A correction the owner made is a fact about their vocabulary, and deleting the
      -- task should not delete what it taught.
      task_id      TEXT,
      field        TEXT NOT NULL,           -- 'category' | 'motivation'
      input_text   TEXT NOT NULL,           -- what the model was judging (title [+ notes])
      llm_value    TEXT NOT NULL,           -- the model's pick (JSON array for category)
      final_value  TEXT,                    -- the owner's value; NULL until they touch it
      assigned_at  TEXT NOT NULL,
      corrected_at TEXT,
      local_date   TEXT NOT NULL            -- 'YYYY-MM-DD' (owner-local day it was assigned)
    );
    -- The learning read: one owner's rows for one field over a date window.
    CREATE INDEX IF NOT EXISTS ix_classification_log_owner_field_date
      ON classification_log(owner_id, field, local_date);
    -- The correction read: the still-open assignment for a task, newest first.
    CREATE INDEX IF NOT EXISTS ix_classification_log_task
      ON classification_log(task_id, field);

    CREATE TABLE IF NOT EXISTS classification_exemplars (
      owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      field         TEXT    NOT NULL,
      log_id        TEXT    NOT NULL,       -- the classification_log row it came from
      input_text    TEXT    NOT NULL,
      llm_value     TEXT    NOT NULL,       -- what the model said then ("you said X")
      correct_value TEXT    NOT NULL,       -- what the owner said ("they meant Y")
      -- Float32 little-endian, as sqlite-vec wants it. NULL when the calibration run
      -- had no embedder: the row is still a usable exemplar for the priors line, it
      -- just cannot be retrieved by similarity.
      embedding     BLOB,
      computed_date TEXT    NOT NULL,
      PRIMARY KEY (owner_id, field, log_id)
    );

    CREATE TABLE IF NOT EXISTS classification_accuracy (
      owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      field         TEXT    NOT NULL,
      computed_date TEXT    NOT NULL,       -- 'YYYY-MM-DD' (owner-local day of the run)
      held_out      INTEGER NOT NULL,       -- examples scored
      correct       INTEGER NOT NULL,
      -- Stored rather than derived so a run with held_out = 0 is distinguishable from
      -- a run that scored 0% — the Jobs trend must not draw a line through "unknown".
      accuracy      REAL,
      PRIMARY KEY (owner_id, field, computed_date)
    );
  `);
}
