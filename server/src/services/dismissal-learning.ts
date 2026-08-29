import { store } from '../db/store.js';
import { localDateInTZ } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { logger } from '../lib/logger.js';
import { cosineSimilarity, packVector, unpackVector } from '../lib/vector.js';
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

/**
 * Cap for the sanitised text rendered into a dismissal hint — shorter than
 * `classification-learning.ts`'s `oneLine` cap of 120. See `sanitizeDismissalText`
 * for why this sanitiser is stricter across the board, not just this number.
 */
export const DISMISSAL_TEXT_CAP = 80;

/**
 * Cap on the text `retrieveDismissals` embeds as its query, chosen to match the
 * MAGNITUDE of what the index holds: an exemplar's `input_text` is a possible's
 * `raw_title` (normalize() caps it at 200) plus its `raw_summary` (capped at 500).
 *
 * Comparability is the point, not just cost. Cosine similarity between a whole email
 * body and a one-line title is dominated by how much ground each text covers rather
 * than by how alike they are, so an uncapped query would rank the index badly even
 * when it answered quickly. The secondary benefit is that a caller cannot hand the
 * embedder an unbounded payload and blow `EMBED_TIMEOUT_MS` — which, because a thrown
 * embed deliberately yields no hint at all rather than falling back to priors, would
 * otherwise silently disable the loop for exactly the longest, noisiest items.
 */
export const QUERY_TEXT_CAP = 700;

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

/** One rollup row read back at retrieval time (ticket 4) — the shape `retrieveDismissals`
 *  hands to `dismissalPrompt`. Same fields as `DismissalEvidence`; kept as a distinct,
 *  exported type because the two describe different moments (batch input vs. rollup
 *  output) even though they carry the same data today. */
export interface DismissalExemplar {
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

// ── Retrieval: what a live extraction reads (ticket 4) ─────────────────────────
//
// Nothing calls this yet — wiring it into `buildPrompt` / `extractTasks` is ticket 5.
// This section only reads the rollup `calibrateDismissals` writes above; it never
// touches `possible_outcome_log` (that is the batch's input, not the request path's)
// and it never writes anything.

const SELECT_DISMISSAL_EXEMPLARS = `
  SELECT log_id, input_text, source_kind, embedding
    FROM possible_dismissal_exemplars WHERE owner_id = ?
   ORDER BY log_id`;

interface StoredDismissalExemplar extends DismissalExemplar {
  vec: number[] | null;
}

async function loadDismissalExemplars(ownerId: string): Promise<StoredDismissalExemplar[]> {
  const rows = await store().prepare(SELECT_DISMISSAL_EXEMPLARS).all<{
    log_id: string; input_text: string; source_kind: string | null; embedding: Buffer | null;
  }>(ownerId);
  return rows.map((r) => ({
    logId: r.log_id,
    inputText: r.input_text,
    sourceKind: r.source_kind,
    vec: unpackVector(r.embedding),
  }));
}

const stripDismissal = (e: StoredDismissalExemplar): DismissalExemplar => ({
  logId: e.logId, inputText: e.inputText, sourceKind: e.sourceKind,
});

/**
 * Grouping key for the priors path: what makes two dismissals "the same kind of noise".
 *
 * Case-, punctuation- and number-insensitive, because the recurring noise this loop
 * exists to learn is near-identical rather than identical — "Invoice #4417 is ready"
 * and "Invoice #5012 is ready" are one pattern the owner keeps throwing away, and an
 * exact-match key would count them as two unrelated singletons. Masking digits is what
 * collapses the part that varies (invoice numbers, dates, unread counts).
 */
function noiseKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * The owner's most recurrent past dismissals — one exemplar per distinct kind of noise,
 * the newest of each — standing in for similarity when there is no embedder.
 *
 * Grouped by `noiseKey(input_text)`, NOT by `source_kind`. That distinction is the whole
 * value of this function: `source_kind` only ever holds 'gmail' | 'gcal' | 'text' (or
 * NULL), so grouping on it yields at most four groups and, for the ordinary owner whose
 * noise all arrives through one channel, exactly ONE exemplar — a near-empty hint
 * precisely when there is no embedder to do better. What `classification-learning.ts`
 * groups by (`correctValue`) is a genuinely multi-valued label; the honest analogue here
 * is the dismissed text itself, since "what does this owner keep rejecting" is the
 * question the priors line is standing in for.
 *
 * Ordered most-recurrent first, then newest — so a pattern dismissed twenty times leads,
 * and when nothing recurs (every group a singleton) this degrades to the k most recent
 * dismissals, which is still a reasonable prior. Rows arrive in ascending `log_id` order
 * (uuid7, so chronological), so `list[list.length - 1]` is the newest of its group.
 *
 * `RETRIEVE_K` is the binding cap on what reaches a prompt and `k` is already clamped to
 * it by the caller; `MAX_PRIORS` bounds the candidate groups considered, and would only
 * become the tighter of the two if `RETRIEVE_K` were ever raised above it.
 */
function frequentDismissals(stored: StoredDismissalExemplar[], k: number): DismissalExemplar[] {
  const byNoise = new Map<string, StoredDismissalExemplar[]>();
  for (const e of stored) {
    const key = noiseKey(e.inputText);
    const list = byNoise.get(key);
    if (list) list.push(e); else byNoise.set(key, [e]);
  }
  return [...byNoise.values()]
    // Most recurrent first; then newest, which also makes the order deterministic
    // (log_id is unique, so no two groups can compare equal).
    .sort((a, b) => b.length - a.length || b[b.length - 1].logId.localeCompare(a[a.length - 1].logId))
    .slice(0, Math.min(k, MAX_PRIORS))
    .map((list) => stripDismissal(list[list.length - 1]));
}

/**
 * The k nearest past dismissals to `text`, or the owner's most frequent dismissals when
 * similarity is unavailable. A pure read of what the last `calibrateDismissals` run
 * wrote — no writes, no model generation, and never a throw. No index, below the
 * floor — the rollup is simply empty, see `calibrateDismissals` — or no embedder all
 * degrade to fewer or no exemplars, because an extraction with no hint is exactly
 * today's behaviour and therefore always a safe answer.
 *
 * Unlike `classification-learning.ts`'s `retrieveExemplars`, an embed call that THROWS
 * (as opposed to `embedReady` reporting false up front) is NOT caught locally and
 * turned into a frequency fallback — it propagates to the catch below and the caller
 * gets `''`. That is deliberate, not an oversight: this text is untrusted third-party
 * content (see the module doc and `sanitizeDismissalText`), and an embedder failing
 * partway through a call is exactly the kind of unexpected condition this ticket's
 * "any thrown error → ''" rule exists for, rather than quietly widening what reaches
 * the extraction prompt.
 *
 * `opts.k` is clamped to `RETRIEVE_K` regardless of what a caller passes — the bound is
 * not the caller's to raise, and neither is the query length: `text` is normalised to
 * `QUERY_TEXT_CAP` before it is embedded, so what gets compared is the same shape and
 * magnitude as the title-plus-summary strings the index was built from. Callers should
 * therefore lead with the most title-like part of their input (a subject line), because
 * that is the part guaranteed to survive the cap.
 */
export async function retrieveDismissals(
  ownerId: string,
  text: string,
  opts: { embedFn?: EmbedFn; k?: number } = {},
): Promise<DismissalExemplar[]> {
  const k = Math.min(opts.k ?? RETRIEVE_K, RETRIEVE_K);
  try {
    const stored = await loadDismissalExemplars(ownerId);
    if (stored.length === 0 || k <= 0) return [];

    // Collapse whitespace before capping: an email body is mostly newlines and quoted
    // indentation, and an exemplar never is, so this both makes the two comparable and
    // buys more real signal inside the cap.
    const probe = text.replace(/\s+/g, ' ').trim().slice(0, QUERY_TEXT_CAP);
    const embed = await resolveEmbed(ownerId, opts.embedFn);
    const withVectors = stored.filter((e): e is StoredDismissalExemplar & { vec: number[] } => e.vec !== null);
    if (embed && withVectors.length > 0 && probe) {
      const query = await embed(probe); // a throw here falls to the catch below, not to priors
      const scored = withVectors
        .filter((e) => e.vec.length === query.length) // a re-embedded index changed dimension
        .map((e) => ({ e, score: cosineSimilarity(query, e.vec) }))
        // Ties broken by log id so two identical scores order the same on every run.
        .sort((a, b) => b.score - a.score || a.e.logId.localeCompare(b.e.logId));
      if (scored.length > 0) return scored.slice(0, k).map(({ e }) => stripDismissal(e));
    }
    return frequentDismissals(stored, k);
  } catch (err) {
    logger.warn('dismissal-learning: retrieval failed', { err: (err as Error).message });
    return [];
  }
}

/**
 * Stricter than `classification-learning.ts`'s `oneLine`. `oneLine` is safe because its
 * input is something the OWNER typed. This one renders the extractor's own rendering of
 * THIRD-PARTY INBOUND EMAIL, replayed into a later extraction prompt whose contract is
 * JSON — a stray `"`, `{` or `}` surviving here can corrupt the response shape, not
 * merely mislead it the way a stray word would. So on top of collapsing whitespace this
 * strips quote and brace characters outright, and caps shorter than `oneLine`'s 120.
 * Do not "simplify" this back to `oneLine` — the input here is untrusted in a way
 * `oneLine`'s never is.
 */
function sanitizeDismissalText(s: string): string {
  return s.replace(/["{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, DISMISSAL_TEXT_CAP);
}

/**
 * The prompt fragment. Empty string when there is nothing to say, so a caller can
 * concatenate it unconditionally and an owner with no dismissals gets byte-identical
 * prompts to today's.
 *
 * Phrased strictly as history ("you suggested X; the user dismissed it"), never as an
 * instruction — no "never suggest", no "ignore". See README.md "Influence, never
 * suppression": this loop biases what gets proposed, it does not filter or suppress.
 *
 * Deliberately no literal quote characters in the template itself (unlike
 * `classification-learning.ts`'s `"${oneLine(...)}"`) — this text is untrusted, and
 * the whole point of `sanitizeDismissalText` is that no `"` survives into the
 * rendered block. Wrapping its output in hand-written quotes would defeat that.
 */
export function dismissalPrompt(exemplars: readonly DismissalExemplar[]): string {
  if (exemplars.length === 0) return '';
  const lines = exemplars
    .map((e) => `- You once suggested a task from something like this: ${sanitizeDismissalText(e.inputText)} — the user dismissed it.`)
    .join('\n');
  return `\nThis user has dismissed suggestions like these before:\n${lines}\n`;
}

/** Retrieve + render in one call — what the extraction prompt actually wants. */
export async function dismissalHint(
  ownerId: string,
  text: string,
  opts: { embedFn?: EmbedFn; k?: number } = {},
): Promise<string> {
  return dismissalPrompt(await retrieveDismissals(ownerId, text, opts));
}
