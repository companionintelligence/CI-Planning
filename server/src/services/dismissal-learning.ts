import { store } from '../db/store.js';
import { localDateInTZ } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { logger } from '../lib/logger.js';
import { packVector } from '../lib/vector.js';
import { ollama } from '../mcp/ollama.js';

/**
 * Close-loop wave, ticket 3 — the batch stage over `possible_outcome_log` (ticket 1's
 * schema, ticket 2's capture). Same contract as `classification-learning.ts`, the
 * nearer of the app's two working learning loops and the template this file mirrors
 * rather than invents from scratch: a deterministic BATCH pass over durable evidence
 * that replaces a regenerable rollup (`possible_dismissal_exemplars`) and appends one
 * measurement row (`possible_dismissal_rate`). **Never online, never mid-request** —
 * a dismissal can only change what the extractor sees after `calibrate_dismissals`
 * runs, so a bad week of dismisses can never bend a live extraction. There is
 * deliberately NO learning-rate pref and NO env knob; when learning underperforms,
 * the sanctioned response is more or better evidence, never a hotter dial.
 *
 * The bounds ARE the contract:
 *  - the rollup learns nothing until an owner has `DISMISSAL_FLOOR` settled dismissals;
 *  - the index is capped at `MAX_EXEMPLARS` per owner;
 *  - at most `RETRIEVE_K` exemplars may ever reach a prompt (ticket 4 enforces it);
 *  - evidence never pools across owners — every read filters `owner_id`.
 *
 * What it does NOT do: retrieve anything or touch a prompt (ticket 4/5's job — this
 * ticket writes an index nobody reads yet), suppress or filter a suggestion (the loop
 * is influence, never suppression — see README.md "Decisions of record"), or write
 * while serving a request.
 *
 * Degradation is silent and total. No Ollama ⇒ the rollup is still rebuilt from
 * durable evidence, just with `embedding = NULL` on every row — learning does not
 * require the model, only similarity RETRIEVAL does (ticket 4). Below the floor, the
 * rollup is emptied rather than left stale, and the job still reports success: an
 * owner with too little evidence is exactly today's behaviour, and that must never
 * read as a red Jobs row.
 */

// ── Named constants — cited by tests and reviewers, not configurable ──────────

/** Evidence window, matching classification-learning's / triality-learning's. */
export const LEARNING_WINDOW_DAYS = 90;

/**
 * A dismissal younger than this has not settled — the mis-click fence. Identical
 * boundary and reasoning to classification-learning's `PENDING_MS`: the owner has not
 * had time to notice a wrong click and reverse it (by promoting), so it is not yet
 * evidence.
 */
export const PENDING_MS = 24 * 3_600_000;

/**
 * Settled dismissals an owner needs before the rollup is built at all. Below it, no
 * exemplar rows exist, and absence means "no hint" — the same way a missing
 * `classification_exemplars` row means the stock prompt.
 *
 * Deliberately ABOVE classification's `CORRECTION_FLOOR` (2). A typed correction is
 * an explicit label the owner wrote; a dismissal is one click, and the downside of
 * over-learning here is a *hidden task* rather than a wrong tag — a materially worse
 * failure than a mis-classified field, so the bar to start learning from it sits
 * higher. What keeps even this floor safe is that influence is bounded elsewhere
 * too: at most `RETRIEVE_K` exemplars ever reach a prompt, and they are phrased as
 * history, not as a rule.
 */
export const DISMISSAL_FLOOR = 5;

/** Index cap per owner. Retrieval scans this set linearly, so it also bounds the
 *  per-extraction cost. */
export const MAX_EXEMPLARS = 200;

/** How many exemplars may ever reach a prompt (ticket 4 enforces it). Small on
 *  purpose: past a handful, a local small model starts pattern-matching the examples
 *  instead of the input. */
export const RETRIEVE_K = 3;

/** How many of an owner's most frequent dismissals stand in for retrieval when there
 *  is no embedder (ticket 4). */
export const MAX_PRIORS = 5;

/** Per-call embedding ceiling. `ollama.embed`'s own default is 30s, which in a batch
 *  of 200 is a job that can hang until morning. */
export const EMBED_TIMEOUT_MS = 3_000;

/** The noise-rate measurement window — how many trailing days one
 *  `possible_dismissal_rate` row covers. */
export const RATE_PERIOD_DAYS = 7;

// ── Types ────────────────────────────────────────────────────────────────────

/** Injectable embedder (the possibles.ts / triality-learning / classification-learning
 *  `embedFn` idiom). `null` forces the no-vector path; `undefined` uses Ollama when it
 *  actually has an embedder pulled. */
export type EmbedFn = ((text: string) => Promise<number[]>) | null | undefined;

/** One settled dismissal — durable evidence that cleared the pending fence and was
 *  not later reversed by a promote. */
interface DismissalEvidence {
  logId: string;
  inputText: string;
  sourceKind: string | null;
}

export interface RateReading {
  periodDays: number;
  /** Suggestions produced for the owner in the trailing period. */
  created: number;
  /** Dismissed + promoted in the period. */
  decided: number;
  dismissed: number;
  /** null when nothing was decided — "unmeasured", which must not plot as 0%. */
  rate: number | null;
  /** Rollup size at the end of THIS run. */
  exemplars: number;
  /** Did the owner's rollup have any rows BEFORE this run's rebuild — i.e. could an
   *  extraction during the trailing period have been influenced by it (ticket 4/5). */
  hinted: boolean;
}

export interface DismissalCalibrationResult {
  /** Settled dismissals examined in the window. */
  settled: number;
  /** Exemplar rows written (0 when the floor was not cleared). */
  indexed: number;
  /** Exemplars written WITH a vector; below `indexed` when no embedder answered. */
  embedded: number;
  /** The floor constant, echoed for the job's log line. */
  floor: number;
  rate: RateReading;
}

// ── SQL (module level, prepared inside functions — house convention) ──────────

const SELECT_WINDOW = `
  SELECT id, possible_task_id, source_kind, input_text, outcome, decided_at
    FROM possible_outcome_log
   WHERE owner_id = ? AND local_date >= ?
   ORDER BY decided_at, id`;

const SELECT_PERIOD_OUTCOMES = `
  SELECT outcome FROM possible_outcome_log WHERE owner_id = ? AND decided_at >= ?`;

const SELECT_CREATED_COUNT = `
  SELECT COUNT(*) n FROM possible_tasks WHERE proposed_owner_id = ? AND created_at >= ?`;

const SELECT_EXEMPLAR_COUNT = `
  SELECT COUNT(*) n FROM possible_dismissal_exemplars WHERE owner_id = ?`;

const DELETE_EXEMPLARS = `DELETE FROM possible_dismissal_exemplars WHERE owner_id = ?`;

const INSERT_EXEMPLAR = `
  INSERT INTO possible_dismissal_exemplars (owner_id, log_id, input_text, source_kind, embedding, computed_date)
  VALUES (?, ?, ?, ?, ?, ?)`;

const UPSERT_RATE = `
  INSERT INTO possible_dismissal_rate
    (owner_id, computed_date, period_days, created, decided, dismissed, rate, exemplars, hinted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (owner_id, computed_date)
  DO UPDATE SET period_days = excluded.period_days, created = excluded.created,
    decided = excluded.decided, dismissed = excluded.dismissed, rate = excluded.rate,
    exemplars = excluded.exemplars, hinted = excluded.hinted`;

// ── Evidence reading ──────────────────────────────────────────────────────────

interface OutcomeRow {
  id: string;
  possible_task_id: string | null;
  source_kind: string | null;
  input_text: string;
  outcome: string;
  decided_at: string;
}

/**
 * Settled dismissals in the learning window, oldest first. A row counts only when:
 * it is inside `LEARNING_WINDOW_DAYS`, its `decided_at` is older than `PENDING_MS`
 * (the mis-click fence), and it is the LATEST outcome recorded for that possible —
 * so a dismissal the owner later reversed by promoting is fenced out entirely.
 *
 * Never throws: `possible_outcome_log` is durable evidence, but a missing or broken
 * table must not fail the batch — it degrades to "no evidence found", same as an
 * owner who has dismissed nothing yet.
 */
async function settledDismissals(ownerId: string, now: Date): Promise<DismissalEvidence[]> {
  try {
    const tz = await ownerTimezone(ownerId);
    const since = localDateInTZ(new Date(now.getTime() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString(), tz);
    const rows = await store().prepare(SELECT_WINDOW).all<OutcomeRow>(ownerId, since);

    // Keep only the LATEST outcome per possible — ascending order means the last
    // write for a key wins. Rows with no possible_task_id (never happens via the
    // capture path, but the column is nullable) can't collide with one another, so
    // key them by their own log id.
    const latest = new Map<string, OutcomeRow>();
    for (const r of rows) latest.set(r.possible_task_id ?? r.id, r);

    // Order the survivors by THEIR OWN decided_at (not first-seen-key order, which
    // is what Map iteration would give) so the caller's newest-first cap is well
    // defined. ISO timestamps sort correctly as strings; the id tiebreak matches
    // every other read in this codebase.
    const settled = [...latest.values()]
      .filter((r) => r.outcome === 'dismissed') // else reversed by a later promote
      .sort((a, b) => a.decided_at.localeCompare(b.decided_at) || a.id.localeCompare(b.id));

    const out: DismissalEvidence[] = [];
    for (const r of settled) {
      const decidedMs = Date.parse(r.decided_at);
      if (!Number.isFinite(decidedMs)) continue; // age unknown — cannot honestly call it settled
      if (now.getTime() - decidedMs < PENDING_MS) continue; // the mis-click fence
      out.push({ logId: r.id, inputText: r.input_text, sourceKind: r.source_kind });
    }
    return out;
  } catch (err) {
    logger.warn('dismissal-learning: could not read outcome log', { err: (err as Error).message });
    return [];
  }
}

// ── Embedder gate ──────────────────────────────────────────────────────────────

/**
 * Resolve the embedder, honouring the readiness gate.
 *
 * The gate is not optional politeness: an ungated embed call against an Ollama with
 * no embedder pulled is what made `triality-routes` look flaky for weeks (#552). An
 * INJECTED embedder is the caller's business and is never gated.
 */
async function resolveEmbed(ownerId: string, embedFn: EmbedFn): Promise<((t: string) => Promise<number[]>) | null> {
  if (embedFn === null) return null;
  if (embedFn !== undefined) return embedFn;
  if (!(await ollama.embedReady(ownerId))) return null;
  return (t: string) => ollama.embed(t, EMBED_TIMEOUT_MS);
}

// ── Rate reading ─────────────────────────────────────────────────────────────

/** The current rollup size, sampled BEFORE the rebuild — the rebuild destroys the
 *  pre-run state, and `hinted` must describe what the extractor could see DURING the
 *  trailing period, not what the rollup looks like after this run rewrites it. */
async function currentExemplarCount(ownerId: string): Promise<number> {
  const row = await store().prepare(SELECT_EXEMPLAR_COUNT).get<{ n: number }>(ownerId);
  return row?.n ?? 0;
}

/** SQLite's `CURRENT_TIMESTAMP` default (used by `possible_tasks.created_at`) is
 *  space-separated UTC with no milliseconds — a different shape from the ISO
 *  `decided_at` this module writes elsewhere. Format the cutoff to match so the
 *  string comparison is honest (never compare the two formats to EACH OTHER — only
 *  each to a cutoff shaped like itself). */
const sqlTimestamp = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

async function readRate(ownerId: string, now: Date, exemplars: number, hinted: boolean): Promise<RateReading> {
  const periodStart = new Date(now.getTime() - RATE_PERIOD_DAYS * 86_400_000);
  let created = 0;
  try {
    const row = await store().prepare(SELECT_CREATED_COUNT).get<{ n: number }>(ownerId, sqlTimestamp(periodStart));
    created = row?.n ?? 0;
  } catch (err) {
    logger.warn('dismissal-learning: could not count created possibles', { err: (err as Error).message });
  }

  let decided = 0;
  let dismissed = 0;
  try {
    const rows = await store().prepare(SELECT_PERIOD_OUTCOMES).all<{ outcome: string }>(ownerId, periodStart.toISOString());
    decided = rows.length;
    dismissed = rows.filter((r) => r.outcome === 'dismissed').length;
  } catch (err) {
    logger.warn('dismissal-learning: could not read outcome log for the rate window', { err: (err as Error).message });
  }

  return {
    periodDays: RATE_PERIOD_DAYS,
    created,
    decided,
    dismissed,
    rate: decided > 0 ? dismissed / decided : null,
    exemplars,
    hinted,
  };
}

// ── Calibration: the batch pass ───────────────────────────────────────────────

/**
 * Rebuild one owner's dismissal-exemplar index and record one noise-rate reading.
 * Deterministic given the same rows and the same clock: the window and the sort are
 * fixed, and the rollup is deleted then reinserted wholesale rather than patched.
 *
 * `now` and `embedFn` are injected — the `possibles.ts` / triality `embedFn` idiom,
 * where `embedFn: null` forces the no-embedder path — so tests never depend on
 * whether this box actually has an embedder pulled.
 */
export async function calibrateDismissals(
  ownerId: string,
  now: Date = new Date(),
  opts: { embedFn?: EmbedFn } = {},
): Promise<DismissalCalibrationResult> {
  const tz = await ownerTimezone(ownerId);
  const computedDate = localDateInTZ(now.toISOString(), tz);

  // Sample BEFORE the rebuild — see currentExemplarCount's doc comment.
  const hinted = (await currentExemplarCount(ownerId)) > 0;

  const evidence = await settledDismissals(ownerId, now);

  let indexed = 0;
  let embedded = 0;

  // Below the floor the index is EMPTIED, not left stale: an owner whose dismissal
  // history ages out of the window, or who never accumulated enough, must stop being
  // hinted by it on the next run.
  if (evidence.length < DISMISSAL_FLOOR) {
    await store().prepare(DELETE_EXEMPLARS).run(ownerId);
  } else {
    // Newest first, then capped: when the cap bites, the owner's recent noise is what
    // survives — a dismissal from three months ago should not outrank last week's.
    const capped = [...evidence].reverse().slice(0, MAX_EXEMPLARS);

    // Embed BEFORE the write transaction. These are network calls, and holding a
    // write open across up to MAX_EXEMPLARS of them would block every other writer
    // for minutes — the index is worth rebuilding, never at the cost of the whole DB.
    const embed = await resolveEmbed(ownerId, opts.embedFn);
    const prepared: { row: DismissalEvidence; vec: Buffer | null }[] = [];
    for (const row of capped) {
      let vec: Buffer | null = null;
      if (embed) {
        try {
          vec = packVector(await embed(row.inputText));
          embedded++;
        } catch (err) {
          // One slow embed must not abandon the rest of the index — the row is still
          // a usable exemplar for the frequency path (ticket 4), just not for
          // similarity.
          logger.debug('dismissal-learning: embed failed for exemplar', { err: (err as Error).message });
        }
      }
      prepared.push({ row, vec });
    }

    // Wholesale replacement, atomically — the classification_exemplars /
    // triality_weights delete-then-insert. The DELETE is load-bearing rather than
    // tidiness: evidence that aged out of the window must STOP hinting, and absence
    // is the only honest representation of "no hint".
    await store().transaction(async () => {
      await store().prepare(DELETE_EXEMPLARS).run(ownerId);
      const ins = store().prepare(INSERT_EXEMPLAR);
      for (const { row, vec } of prepared) {
        await ins.run(ownerId, row.logId, row.inputText, row.sourceKind, vec, computedDate);
      }
    });
    indexed = capped.length;
  }

  const rate = await readRate(ownerId, now, indexed, hinted);
  await store()
    .prepare(UPSERT_RATE)
    .run(ownerId, computedDate, rate.periodDays, rate.created, rate.decided, rate.dismissed, rate.rate, rate.exemplars, rate.hinted ? 1 : 0);

  return { settled: evidence.length, indexed, embedded, floor: DISMISSAL_FLOOR, rate };
}
