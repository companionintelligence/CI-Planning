import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { localDateInTZ } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { logger } from '../lib/logger.js';
import { cosineSimilarity, packVector, unpackVector } from '../lib/vector.js';
import { ollama } from '../mcp/ollama.js';

/**
 * Phase 8 — the parse/classify LLM learns the owner's own vocabulary.
 *
 * Same contract as services/triality-learning.ts, which is the house rule and not a
 * suggestion: a deterministic BATCH pass over durable evidence (`classification_log`)
 * that replaces a regenerable rollup (`classification_exemplars`). **Never online,
 * never mid-request** — a classification can only change behaviour after
 * `calibrate_classification` runs, so a bad afternoon of corrections cannot bend a
 * live answer. There is deliberately NO learning-rate pref and NO env knob; when
 * learning underperforms, the sanctioned response is more or better evidence, never
 * a hotter dial.
 *
 * The bounds ARE the contract:
 *  - a field learns nothing until it has `CORRECTION_FLOOR` real corrections;
 *  - the index is capped at `MAX_EXEMPLARS` per owner and field;
 *  - at most `RETRIEVE_K` exemplars ever reach a prompt;
 *  - the held-out slice is a fixed stride, not a sample, so a run is reproducible.
 *
 * What it does NOT do: fine-tune anything, share evidence across owners (never — the
 * log is owner-scoped by construction and every read filters on it), or write while
 * serving a request. Retrieval at classification time is a pure READ of what the last
 * batch produced.
 *
 * Degradation is silent and total, in both directions. No Ollama ⇒ nothing classifies
 * in the first place, so there is nothing to learn from; corrections still accumulate,
 * so learning resumes with history when the model returns. Ollama but no embedder
 * pulled ⇒ similarity retrieval is skipped and the prompt falls back to the owner's
 * most frequent corrections, which needs no vectors. Neither path throws, and neither
 * changes what a task looks like when it is created.
 */

// ── Named constants — cited by tests and reviewers, not configurable ──────────

/** Evidence window, matching triality-learning's. */
export const LEARNING_WINDOW_DAYS = 90;

/**
 * An assignment the owner has not touched within this long is a WEAK POSITIVE: they
 * saw it and let it stand. Younger than this and untouched, it is PENDING — undecided,
 * so not evidence at all. Identical boundary and reasoning to triality-learning's
 * `PENDING_MS`: strictly younger than 24h ⇒ pending.
 */
export const PENDING_MS = 24 * 3_600_000;

/**
 * Corrections a field needs before the index is built at all. Below it, no exemplar
 * rows exist, and absence means "the stock prompt" — the same way a missing
 * `triality_weights` row means the §5 defaults.
 *
 * TWO, because the owner's acceptance test is "correcting a task's category twice
 * makes the third similar input classify correctly". That is far below triality's
 * `OUTCOME_FLOOR` of 20, and deliberately so: these are not weak behavioural signals
 * to average over, they are explicit labelled corrections the owner typed. One is
 * still not enough — a single edit can be a slip — but the second says it was meant.
 *
 * What keeps a low floor safe is that influence is bounded elsewhere rather than
 * here: at most `RETRIEVE_K` exemplars reach a prompt, only ones similar to the input
 * are retrieved, and they are phrased as past corrections rather than as rules.
 */
export const CORRECTION_FLOOR = 2;

/** Index cap per owner and field. Retrieval scans this set linearly, so it also
 *  bounds the per-classification cost. */
export const MAX_EXEMPLARS = 200;

/** How many exemplars may reach a prompt. Small on purpose: past a handful, a local
 *  small model starts pattern-matching the examples instead of the task. */
export const RETRIEVE_K = 3;

/** How many of an owner's most frequent corrections stand in for retrieval when there
 *  is no embedder. */
export const MAX_PRIORS = 5;

/** Every Nth corrected example is held out for scoring instead of indexed. A fixed
 *  stride rather than a random sample: determinism is asserted, not hoped for. */
export const HELD_OUT_STRIDE = 4;

/** Ceiling on scored examples per field per run — each one is a model call. */
export const MAX_SCORED = 20;

/** Per-call embedding ceiling. `ollama.embed`'s own default is 30s, which in a batch
 *  of 200 is a job that can hang until morning. */
export const EMBED_TIMEOUT_MS = 3_000;

/** The two things the owner corrects. Enforced here, not by a CHECK constraint. */
export const FIELDS = ['category', 'motivation'] as const;
export type ClassifiedField = (typeof FIELDS)[number];

// ── Types ────────────────────────────────────────────────────────────────────

export interface Exemplar {
  logId: string;
  inputText: string;
  /** What the model said at the time — the "you said X" half of the lesson. */
  llmValue: string;
  /** What the owner settled on. */
  correctValue: string;
}

/** One decided piece of evidence. `corrected` false = the owner let it stand. */
export interface DecidedRow extends Exemplar {
  corrected: boolean;
  assignedAt: string;
}

export interface FieldCalibration {
  field: ClassifiedField;
  /** Decided (non-pending) rows examined in the window. */
  decided: number;
  /** Corrections among them — the strong labeled examples. */
  corrections: number;
  /** Exemplar rows written (0 when the floor was not cleared). */
  indexed: number;
  /** Exemplars written WITH a vector; below `indexed` when no embedder answered. */
  embedded: number;
  /** Of `embedded`, how many carried an EXISTING vector over from the prior index by
   *  log_id instead of being freshly embedded this run — the win reuse is worth. */
  reused: number;
  /** Held-out examples scored, and how many the classifier got right. */
  heldOut: number;
  correct: number;
  /** null when nothing was scored — "unknown", which must not plot as 0%. */
  accuracy: number | null;
}

export interface ClassificationCalibrationResult {
  fields: FieldCalibration[];
  /** The floor constant, echoed for the job's log line. */
  floor: number;
}

// ── SQL (module level, prepared inside functions — §5.5) ──────────────────────

const INSERT_LOG = `
  INSERT INTO classification_log (id, owner_id, task_id, field, input_text, llm_value, assigned_at, local_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * The still-open assignment for a task and field, newest first. "Open" means the owner
 * has not yet touched it; once corrected, the row is settled evidence and a later edit
 * starts nothing new — the model only made one claim, and the owner's first answer to
 * it is the lesson.
 */
const SELECT_OPEN_ASSIGNMENT = `
  SELECT id, llm_value FROM classification_log
   WHERE task_id = ? AND field = ? AND owner_id = ? AND corrected_at IS NULL
   ORDER BY assigned_at DESC LIMIT 1`;

const CLOSE_ASSIGNMENT = `
  UPDATE classification_log SET final_value = ?, corrected_at = ?
   WHERE id = ? AND corrected_at IS NULL`;

const SELECT_WINDOW = `
  SELECT id, input_text, llm_value, final_value, assigned_at, corrected_at
    FROM classification_log
   WHERE owner_id = ? AND field = ? AND local_date >= ?
   ORDER BY assigned_at, id`;

const DELETE_EXEMPLARS = `DELETE FROM classification_exemplars WHERE owner_id = ? AND field = ?`;
const INSERT_EXEMPLAR = `
  INSERT INTO classification_exemplars (owner_id, field, log_id, input_text, llm_value, correct_value, embedding, computed_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const SELECT_EXEMPLARS = `
  SELECT log_id, input_text, llm_value, correct_value, embedding
    FROM classification_exemplars WHERE owner_id = ? AND field = ?
   ORDER BY log_id`;

const UPSERT_ACCURACY = `
  INSERT INTO classification_accuracy (owner_id, field, computed_date, held_out, correct, accuracy)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (owner_id, field, computed_date)
  DO UPDATE SET held_out = excluded.held_out, correct = excluded.correct, accuracy = excluded.accuracy`;

// ── Capture: the durable evidence ─────────────────────────────────────────────

/** The text a classification was made from, normalized once so the log, the index and
 *  a retrieval query are always the same string for the same task. */
export function classificationInput(title: string, notes?: string | null): string {
  const n = notes?.trim();
  return (n ? `${title.trim()}\n${n.slice(0, 300)}` : title.trim()).slice(0, 500);
}

/** Category picks are an ordered set; one canonical string so equality is decidable. */
export function canonicalValue(value: string | readonly string[] | null | undefined): string {
  if (value == null) return '';
  const list = Array.isArray(value) ? value : [String(value)];
  return list.map((v) => String(v).trim()).filter(Boolean).join(', ');
}

/**
 * Record that the model assigned `llmValue` to a task. Called AFTER the write lands,
 * so the log never claims an assignment the guarded UPDATE rejected.
 *
 * Never throws: a classification that succeeded must not be reported as failed because
 * the learning log had a bad day. A dropped row costs one example out of a 90-day
 * window; a thrown error costs the user their enrichment.
 */
export async function logAssignment(
  ownerId: string,
  input: { taskId: string | null; field: ClassifiedField; inputText: string; llmValue: string | readonly string[] },
  now: Date = new Date(),
): Promise<void> {
  try {
    const value = canonicalValue(input.llmValue);
    if (!value || !input.inputText.trim()) return; // nothing was claimed → nothing to learn
    const tz = await ownerTimezone(ownerId);
    await store().prepare(INSERT_LOG).run(
      newId(), ownerId, input.taskId, input.field,
      input.inputText, value, now.toISOString(), localDateInTZ(now.toISOString(), tz),
    );
  } catch (err) {
    logger.warn('classification-learning: could not log assignment', { err: (err as Error).message });
  }
}

/**
 * Close the open assignment for a task with what the owner settled on. A no-op when
 * the model never assigned this field (the owner's own first answer teaches nothing —
 * there was no claim to correct) or when the row is already settled.
 *
 * Returns whether a row was closed, for tests and callers that want to know; never
 * throws, for the same reason as `logAssignment`.
 */
export async function recordCorrection(
  ownerId: string,
  taskId: string,
  field: ClassifiedField,
  finalValue: string | readonly string[] | null,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const open = await store().prepare(SELECT_OPEN_ASSIGNMENT)
      .get<{ id: string; llm_value: string }>(taskId, field, ownerId);
    if (!open) return false;
    const value = canonicalValue(finalValue);
    const r = await store().prepare(CLOSE_ASSIGNMENT).run(value, now.toISOString(), open.id);
    return r.changes > 0;
  } catch (err) {
    logger.warn('classification-learning: could not record correction', { err: (err as Error).message });
    return false;
  }
}

// ── Evidence reading ──────────────────────────────────────────────────────────

interface LogRow {
  id: string;
  input_text: string;
  llm_value: string;
  final_value: string | null;
  assigned_at: string;
  corrected_at: string | null;
}

/**
 * What a log row is worth, or `null` for "not evidence".
 *
 * Null means genuinely undecided — an untouched assignment younger than `PENDING_MS`,
 * or one whose `assigned_at` will not parse (age unknown, so we cannot honestly call
 * it accepted). Null rows are excluded from BOTH the maths and the counts, so a fresh
 * assignment can never dilute a field toward its floor.
 *
 * An owner who "corrects" a value to the same thing the model chose has agreed with
 * it, not corrected it — that is an `accepted`, and treating it as a correction would
 * fill the index with examples that teach nothing.
 */
export function rowOutcome(row: LogRow, now: Date): 'corrected' | 'accepted' | null {
  if (row.corrected_at) {
    return canonicalValue(row.final_value) === canonicalValue(row.llm_value) ? 'accepted' : 'corrected';
  }
  const assignedMs = Date.parse(row.assigned_at);
  if (!Number.isFinite(assignedMs)) return null;
  return now.getTime() - assignedMs < PENDING_MS ? null : 'accepted';
}

/** Decided rows for a field in the learning window, oldest first. */
export async function decidedRows(
  ownerId: string,
  field: ClassifiedField,
  now: Date,
): Promise<DecidedRow[]> {
  const tz = await ownerTimezone(ownerId);
  const since = localDateInTZ(new Date(now.getTime() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString(), tz);
  const rows = await store().prepare(SELECT_WINDOW).all<LogRow>(ownerId, field, since);
  const out: DecidedRow[] = [];
  for (const r of rows) {
    const outcome = rowOutcome(r, now);
    if (outcome === null) continue;
    out.push({
      logId: r.id,
      inputText: r.input_text,
      llmValue: r.llm_value,
      correctValue: outcome === 'corrected' ? canonicalValue(r.final_value) : r.llm_value,
      corrected: outcome === 'corrected',
      assignedAt: r.assigned_at,
    });
  }
  return out;
}

// ── Retrieval: what a live classification reads ───────────────────────────────

/** Injectable embedder (the possibles.ts / triality embedFn idiom). `null` forces the
 *  no-vector path; `undefined` uses Ollama when it actually has an embedder pulled. */
export type EmbedFn = ((text: string) => Promise<number[]>) | null | undefined;

interface StoredExemplar extends Exemplar {
  vec: number[] | null;
}

async function loadExemplars(ownerId: string, field: ClassifiedField): Promise<StoredExemplar[]> {
  const rows = await store().prepare(SELECT_EXEMPLARS).all<{
    log_id: string; input_text: string; llm_value: string; correct_value: string; embedding: Buffer | null;
  }>(ownerId, field);
  return rows.map((r) => ({
    logId: r.log_id,
    inputText: r.input_text,
    llmValue: r.llm_value,
    correctValue: r.correct_value,
    vec: unpackVector(r.embedding),
  }));
}

/**
 * Resolve the embedder, honouring the readiness gate.
 *
 * The gate is not optional politeness: an ungated embed call against an Ollama with no
 * embedder pulled is what made `triality-routes` look flaky for weeks (#552). An
 * INJECTED embedder is the caller's business and is never gated.
 */
async function resolveEmbed(ownerId: string, embedFn: EmbedFn): Promise<((t: string) => Promise<number[]>) | null> {
  if (embedFn === null) return null;
  if (embedFn !== undefined) return embedFn;
  if (!(await ollama.embedReady(ownerId))) return null;
  return (t: string) => ollama.embed(t, EMBED_TIMEOUT_MS);
}

/**
 * The k nearest corrected examples to `text`, or the owner's most frequent corrections
 * when similarity is unavailable.
 *
 * A pure read of what the last calibration wrote — no writes, no model generation, and
 * never a throw. Every failure (no index, no embedder, a slow or broken embed call, a
 * stored vector of the wrong length) degrades to fewer or no exemplars, because a
 * classification with no examples is exactly today's behaviour and therefore always a
 * safe answer.
 */
export async function retrieveExemplars(
  ownerId: string,
  field: ClassifiedField,
  text: string,
  opts: { embedFn?: EmbedFn; k?: number } = {},
): Promise<Exemplar[]> {
  const k = opts.k ?? RETRIEVE_K;
  try {
    const stored = await loadExemplars(ownerId, field);
    if (stored.length === 0 || k <= 0) return [];

    const embed = await resolveEmbed(ownerId, opts.embedFn);
    const withVectors = stored.filter((e): e is StoredExemplar & { vec: number[] } => e.vec !== null);
    if (embed && withVectors.length > 0 && text.trim()) {
      let query: number[];
      try {
        query = await embed(text);
      } catch (err) {
        // The embedder was there and still did not answer. Fall through to frequency
        // rather than failing the classification — this is the timeout path.
        logger.debug('classification-learning: embed failed, using frequency priors', { err: (err as Error).message });
        return frequentCorrections(stored, k);
      }
      const scored = withVectors
        .filter((e) => e.vec.length === query.length) // a re-embedded index changed dimension
        .map((e) => ({ e, score: cosineSimilarity(query, e.vec) }))
        // Ties broken by log id so two identical scores order the same on every run.
        .sort((a, b) => b.score - a.score || a.e.logId.localeCompare(b.e.logId));
      if (scored.length > 0) return scored.slice(0, k).map(({ e }) => strip(e));
    }
    return frequentCorrections(stored, k);
  } catch (err) {
    logger.warn('classification-learning: retrieval failed', { err: (err as Error).message });
    return [];
  }
}

const strip = (e: StoredExemplar): Exemplar => ({
  logId: e.logId, inputText: e.inputText, llmValue: e.llmValue, correctValue: e.correctValue,
});

/**
 * The no-embedder fallback: one exemplar per most-frequently-corrected value — the
 * newest of each. It answers a coarser question than similarity — "what does
 * this owner usually mean" rather than "what did they mean about THIS" — which is
 * exactly the right thing to lose first when vectors are unavailable.
 */
function frequentCorrections(stored: StoredExemplar[], k: number): Exemplar[] {
  const byValue = new Map<string, StoredExemplar[]>();
  for (const e of stored) {
    const list = byValue.get(e.correctValue);
    if (list) list.push(e); else byValue.set(e.correctValue, [e]);
  }
  return [...byValue.entries()]
    // Most-corrected value first; ties by value name so the order is stable.
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, Math.min(k, MAX_PRIORS))
    .map(([, list]) => strip(list[list.length - 1]));
}

/**
 * The prompt fragment. Empty string when there is nothing to say, so a caller can
 * concatenate it unconditionally and an owner with no corrections gets byte-identical
 * prompts to today's.
 *
 * Phrased as a correction rather than a rule ("you said X, they meant Y") because that
 * is what the evidence actually is. A small local model told "always use Finance"
 * over-applies it; shown three specific misses, it generalises about as far as it
 * should.
 */
export function exemplarPrompt(exemplars: readonly Exemplar[]): string {
  if (exemplars.length === 0) return '';
  const lines = exemplars
    .map((e) => `- For "${oneLine(e.inputText)}" you said ${e.llmValue || '(nothing)'}; the user chose ${e.correctValue}.`)
    .join('\n');
  return `\nThis user has corrected you before. Follow their vocabulary, not your own:\n${lines}\n`;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 120);

/** Retrieve + render in one call — what the classifiers actually want. */
export async function classificationHint(
  ownerId: string,
  field: ClassifiedField,
  text: string,
  opts: { embedFn?: EmbedFn; k?: number } = {},
): Promise<string> {
  return exemplarPrompt(await retrieveExemplars(ownerId, field, text, opts));
}

// ── Calibration: the batch pass ───────────────────────────────────────────────

/**
 * Score one held-out example. Injectable so the job is testable without a model, and
 * so the scorer can be the SAME classifier the prompt path uses rather than a proxy.
 */
export type ScoreFn = (args: {
  field: ClassifiedField;
  inputText: string;
  hint: string;
}) => Promise<string | null>;

/**
 * Rebuild one owner's exemplar index and measure it. Deterministic given the same rows
 * and the same clock: the window, the stride and every sort are fixed.
 *
 * The split is a fixed stride over the corrected rows in (assigned_at, id) order —
 * every `HELD_OUT_STRIDE`-th row is scored instead of indexed. Held-out rows are NOT
 * in the index they are scored against, which is the whole point: an example that
 * grades itself measures nothing.
 */
export async function calibrateClassification(
  ownerId: string,
  now: Date = new Date(),
  opts: { embedFn?: EmbedFn; scoreFn?: ScoreFn } = {},
): Promise<ClassificationCalibrationResult> {
  const tz = await ownerTimezone(ownerId);
  const computedDate = localDateInTZ(now.toISOString(), tz);
  const fields: FieldCalibration[] = [];

  for (const field of FIELDS) {
    const decided = await decidedRows(ownerId, field, now);
    const corrections = decided.filter((r) => r.corrected);

    // Below the floor the index is EMPTIED, not left stale: an owner who deletes their
    // corrections must stop being taught by them on the next run.
    if (corrections.length < CORRECTION_FLOOR) {
      await store().prepare(DELETE_EXEMPLARS).run(ownerId, field);
      fields.push({
        field, decided: decided.length, corrections: corrections.length,
        indexed: 0, embedded: 0, reused: 0, heldOut: 0, correct: 0, accuracy: null,
      });
      continue;
    }

    const heldOut: DecidedRow[] = [];
    const train: DecidedRow[] = [];
    corrections.forEach((r, i) => ((i + 1) % HELD_OUT_STRIDE === 0 ? heldOut : train).push(r));
    // Newest first, then capped: when the cap bites, the owner's recent vocabulary is
    // what survives — a correction from three months ago should not outrank last week's.
    const indexed = [...train].reverse().slice(0, MAX_EXEMPLARS);

    // Reuse a vector by log_id rather than re-embedding it. `classification_log.
    // input_text` is write-once (the only later UPDATE touches final_value/
    // corrected_at, never input_text — see the INSERT/UPDATE pair above), so a vector
    // embedded for a given log_id in an earlier run is STILL that log_id's correct
    // vector today. Without this, every run re-embedded the WHOLE index from scratch —
    // up to MAX_EXEMPLARS rows per field, most of which had not changed since the run
    // before, on a job that runs weekly across every owner.
    const priorRows = await store()
      .prepare(SELECT_EXEMPLARS)
      .all<{ log_id: string; input_text: string; embedding: Buffer | null }>(ownerId, field);
    const priorByLogId = new Map(priorRows.map((r) => [r.log_id, r] as const));

    // Embed BEFORE the swap. These are network calls, and holding a write transaction
    // open across up to MAX_EXEMPLARS of them would block every other writer for
    // minutes — the index is worth rebuilding, never at the cost of the whole DB.
    const embed = await resolveEmbed(ownerId, opts.embedFn);
    const prepared: { row: DecidedRow; vec: Buffer | null }[] = [];
    let embedded = 0;
    let reused = 0;
    for (const row of indexed) {
      // input_text can never actually change for a given log_id (see above) — this
      // equality check is defensive, not load-bearing, so a future write path that DID
      // start editing it fails safe here (falls through and re-embeds) instead of
      // silently serving a vector for text it no longer matches.
      const prior = priorByLogId.get(row.logId);
      if (prior?.embedding && prior.input_text === row.inputText) {
        prepared.push({ row, vec: prior.embedding });
        embedded++;
        reused++;
        continue;
      }
      let vec: Buffer | null = null;
      if (embed) {
        try {
          vec = packVector(await embed(row.inputText));
          embedded++;
        } catch (err) {
          // One slow embed must not abandon the rest of the index — the row is still a
          // usable exemplar for the frequency path, just not for similarity.
          logger.debug('classification-learning: embed failed for exemplar', { err: (err as Error).message });
        }
      }
      prepared.push({ row, vec });
    }

    // Wholesale replacement, atomically (the calibrate_estimates / calibrate_triality
    // delete-then-insert). The DELETE is load-bearing rather than tidiness: corrections
    // that aged out of the window, or a log the owner reset, must STOP teaching, and
    // absence is the only honest representation of "back on the stock prompt".
    await store().transaction(async () => {
      await store().prepare(DELETE_EXEMPLARS).run(ownerId, field);
      const ins = store().prepare(INSERT_EXEMPLAR);
      for (const { row, vec } of prepared) {
        await ins.run(ownerId, field, row.logId, row.inputText, row.llmValue, row.correctValue, vec, computedDate);
      }
    });

    const scored = await scoreHeldOut(ownerId, field, heldOut, opts);
    await store().prepare(UPSERT_ACCURACY).run(
      ownerId, field, computedDate, scored.heldOut, scored.correct, scored.accuracy,
    );

    fields.push({
      field,
      decided: decided.length,
      corrections: corrections.length,
      indexed: indexed.length,
      embedded,
      reused,
      ...scored,
    });
  }

  return { fields, floor: CORRECTION_FLOOR };
}

/**
 * Grade the held-out slice against the index that was just written. Without a scorer
 * (no Ollama) nothing is scored and accuracy is `null` — "not measured", which the
 * Jobs trend must show as a gap rather than as a bad week.
 */
async function scoreHeldOut(
  ownerId: string,
  field: ClassifiedField,
  heldOut: readonly DecidedRow[],
  opts: { embedFn?: EmbedFn; scoreFn?: ScoreFn },
): Promise<{ heldOut: number; correct: number; accuracy: number | null }> {
  const scoreFn = opts.scoreFn;
  if (!scoreFn || heldOut.length === 0) return { heldOut: 0, correct: 0, accuracy: null };

  let n = 0;
  let correct = 0;
  for (const row of heldOut.slice(0, MAX_SCORED)) {
    let answer: string | null;
    try {
      const hint = await classificationHint(ownerId, field, row.inputText, { embedFn: opts.embedFn });
      answer = await scoreFn({ field, inputText: row.inputText, hint });
    } catch (err) {
      // An unscoreable example is not a wrong answer. Counting it as one would make the
      // trend say "learning got worse" when what actually happened is the model fell over.
      logger.debug('classification-learning: scoring call failed', { err: (err as Error).message });
      continue;
    }
    if (answer === null) continue;
    n++;
    if (canonicalValue(answer) === canonicalValue(row.correctValue)) correct++;
  }
  return { heldOut: n, correct, accuracy: n > 0 ? correct / n : null };
}

/** The most recent measured accuracy per field — what the Jobs view plots. */
export async function accuracyTrend(
  ownerId: string,
  limit = 12,
): Promise<{ field: string; computed_date: string; held_out: number; correct: number; accuracy: number | null }[]> {
  return await store()
    .prepare(
      `SELECT field, computed_date, held_out, correct, accuracy
         FROM classification_accuracy WHERE owner_id = ?
        ORDER BY computed_date DESC, field LIMIT ?`,
    )
    .all(ownerId, limit);
}
