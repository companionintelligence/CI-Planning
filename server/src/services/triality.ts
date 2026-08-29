import { createHash } from 'node:crypto';
import { store } from '../db/store.js';
import { ollama } from '../mcp/ollama.js';
import { resolveEmbedModel } from '../lib/models.js';
import { logger } from '../lib/logger.js';
import { localDateInTZ, utcToZonedWallTime } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { entityCategoryNames } from './tags.js';
import { buildSituationVector, type SituationVector } from './triality-vector.js';

/**
 * Triality scoring engine (docs/triality-design.md §1, §4, §5) — the whole
 * pipeline as one pure, owner-scoped service:
 *
 *   candidates → capacity FILTER (hard) → component scores F/H/Q/N/C
 *              → ternary triple + target dot-products → greedy exclusive slots
 *              → three picks (or an honest refusal / empty slot)
 *
 * Deterministic by construction: injectable clock (`now`), injectable embed +
 * weights fns for tests, stable tie-breaks, no wall-clock, no Math.random, and
 * NO LLM anywhere in the scoring path (the two-clocks doctrine — the optional
 * rationale garnish lives in a later wave, outside this module's math).
 */

// ── Vocabulary + weights (canonical: habitual · contextual · novel) ───────────

export type Slot = 'habitual' | 'contextual' | 'novel';
export const SLOTS: readonly Slot[] = ['habitual', 'contextual', 'novel'];

export interface SlotWeights { F: number; H: number; Q: number; N: number; C: number }

/** Design §5 defaults. Named constants, not prefs — the log tells us what to
 *  tune before we expose knobs, and T8's learning reads through getWeights. */
export const DEFAULT_WEIGHTS: Record<Slot, SlotWeights> = {
  habitual:   { F: 0.40, H: 0.40, Q: 0.20, N: 0,    C: 0 },
  contextual: { F: 0.50, H: 0.20, Q: 0,    N: 0.30, C: 0 },
  novel:      { F: 0.35, H: 0.15, Q: 0,    N: 0.30, C: 0.20 },
};

/** Slot targets over the ternary triple [normality, pragmatism, capacity] (§5). */
const TARGETS: Record<Slot, readonly [number, number, number]> = {
  habitual:   [+1, +1, +1],
  contextual: [ 0, +1, +1],
  novel:      [-1, +1, +1],
};

const COMPONENTS = ['F', 'H', 'Q', 'N', 'C'] as const;

/**
 * The ONE seam scoring reads weights through (§6b). A learned `triality_weights`
 * row wins; ABSENCE means defaults, never zeros — that distinction is what lets
 * the learning job simply not write a floored slot.
 *
 * A malformed/partial stored row degrades to the defaults rather than throwing:
 * a corrupt derived row must never take the suggestion surface down, and the
 * evidence to recompute it still sits in triality_log.
 */
// SQL at module scope, prepare at the use site (§5.5).
const SQL_WEIGHTS = `SELECT weights FROM triality_weights WHERE owner_id = ? AND slot = ?`;

export async function getWeights(ownerId: string, slot: Slot): Promise<SlotWeights> {
  // Every fallback returns a COPY: DEFAULT_WEIGHTS is exported, and handing out a
  // reference to it makes a future caller's in-place tweak a global default change.
  const defaults = () => ({ ...DEFAULT_WEIGHTS[slot] });
  const row = await store().prepare(SQL_WEIGHTS).get<{ weights: string }>(ownerId, slot);
  if (!row) return defaults();
  try {
    const parsed = JSON.parse(row.weights) as Record<string, unknown>;
    const out = { ...DEFAULT_WEIGHTS[slot] };
    let sum = 0;
    for (const k of COMPONENTS) {
      const v = parsed[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return defaults();
      // Enforce the §6b contract on READ, both ends: a legitimate written row is
      // within [½·default, 2·default] (zero-default components exactly 0 — learning
      // scales defaults, so it can never invent a component the slot doesn't use).
      // The writer guarantees this; a restore or hand-edit does not, and an
      // accepted 1e9 here shipped a 500000000 score total to the client in review.
      // The 0.5/2 bounds are §6b's CLAMP_LO/CLAMP_HI (triality-learning.ts) — a
      // deliberate two-site constant: this module cannot import them without a cycle.
      const d = DEFAULT_WEIGHTS[slot][k];
      if (d === 0 ? v !== 0 : v < 0.5 * d || v > 2 * d) {
        logger.info('triality: learned weight outside its contract bounds — falling back to defaults', { ownerId, slot, k, v });
        return defaults();
      }
      out[k] = v;
      sum += v;
    }
    // An all-zero row is the one corrupt state the writer cannot produce but a
    // restore or hand-edit can. It would zero every candidate's total and quietly
    // reduce slot assignment to the id tie-break — so treat it as corrupt, which is
    // what the fallback above already promises for every other malformed shape.
    if (!(sum > 0)) {
      logger.info('triality: learned weights sum to zero — falling back to defaults', { ownerId, slot });
      return defaults();
    }
    return out;
  } catch {
    logger.info('triality: unparseable learned weights — falling back to defaults', { ownerId, slot });
    return defaults();
  }
}
// Returns SlotWeights or a promise of them: getWeights is async now, but the test
// injections hand back a plain object, and `await` accepts either.
export type GetWeightsFn = (ownerId: string, slot: Slot) => SlotWeights | Promise<SlotWeights>;

// ── Tunables (documented bounds, not silent caps — §"no silent caps") ─────────

const WINDOW_DAYS = 90;        // H/Q/refusal evidence window (matches the metrics tab's longest)
const HALF_LIFE_DAYS = 14;     // recency half-life for H
const POOL_CAP = 60;           // max open tasks considered per run (priority-ordered; logged when hit)
const REFUSAL_FLOOR = 10;      // confirmed completions needed before ranking at all (§4)
const EMBED_BLEND = 0.5;       // N = blend of categorical novelty and embedding distance
const GAP_MARGIN_MIN = 5;      // capacity filter: estimate must fit the gap with this margin
// Bounds on the ONLY I/O in the scoring path (embeddings for N). Both are documented
// caps, not silent truncation: exceeding either logs and degrades the whole stage to
// categorical novelty, never a partially-embedded pool.
const EMBED_CANDIDATE_CAP = 40;   // pool size past which embedding is skipped entirely
const EMBED_TIMEOUT_MS = 3_000;   // per-call ceiling (ollama.embed's own default is 30s)
const NOVELTY_BUDGET_MS = 4_000;  // whole-stage deadline, centroid + candidates together
const CENTROID_TITLES = 25;       // completed titles the centroid averages over

// ── Centroid cache (per owner) ────────────────────────────────────────────────

/**
 * The completed-history centroid, remembered per owner between requests.
 *
 * The 25 titles it averages change only when the owner COMPLETES something, but the
 * centroid was rebuilt from scratch on every request — 25 embeddings, every time, to
 * recompute a vector that was bit-for-bit identical to the last one. That was the single
 * largest block of repeated model work in the scoring path, and unlike the candidate
 * embeddings it bought nothing at all: same input, same model, same answer.
 *
 * INVALIDATION IS THE FINGERPRINT, not a TTL. The key covers the embedding model and the
 * exact title list the centroid was built from, so a completion, an edited title, or a
 * task ageing out of the 90-day window all change it and force a rebuild. A model swap
 * changes it too — that one is load-bearing rather than tidy, because vectors from two
 * models are not comparable and their dimensions need not even match. There is therefore
 * no window in which a stale centroid can be served: a hit is, by construction, exactly
 * what a rebuild would have produced.
 *
 * Keyed BY OWNER even though a vector is a pure function of (model, title). Sharing one
 * cache across owners would make a hit observable to a tenant who did not populate it,
 * turning "is anyone else on this box tracking <title>" into a timing question. One entry
 * per owner also bounds the thing naturally.
 *
 * In-process and lost on restart, like the Ollama probe cache and the tz formatter cache.
 * Nothing here is worth persisting: rebuilding costs one request's worth of embeddings.
 */
const CENTROID_CACHE_MAX = 64;

interface CachedCentroid {
  /** Embedding model + the exact titles this centroid was built from. */
  fingerprint: string;
  /** Never mutated — `squashedCosineDistance` only reads — so it is shared, not copied. */
  centroid: readonly number[];
}

const centroidCache = new Map<string, CachedCentroid>();

/** Hash (model, titles) into one comparable key. The NUL separator keeps
 *  ['ab','c'] from fingerprinting the same as ['a','bc']. */
function centroidFingerprint(model: string, titles: readonly string[]): string {
  const h = createHash('sha1').update(model);
  for (const t of titles) h.update('\0').update(t);
  return h.digest('hex');
}

function cachedCentroidFor(ownerId: string, fingerprint: string): readonly number[] | null {
  const hit = centroidCache.get(ownerId);
  if (!hit || hit.fingerprint !== fingerprint) return null;
  centroidCache.delete(ownerId); // re-insert to keep Map order least-recently-used first
  centroidCache.set(ownerId, hit);
  return hit.centroid;
}

function rememberCentroid(ownerId: string, fingerprint: string, centroid: readonly number[]): void {
  centroidCache.delete(ownerId);
  centroidCache.set(ownerId, { fingerprint, centroid });
  while (centroidCache.size > CENTROID_CACHE_MAX) {
    const oldest = centroidCache.keys().next();
    if (oldest.done) break;
    centroidCache.delete(oldest.value);
  }
}

/** Test-only: forget every cached centroid so cases don't bleed into each other. */
export function __resetCentroidCache(): void {
  centroidCache.clear();
}

/** Test-only: live entry count, so the LRU ceiling can be asserted directly rather than
 *  inferred from a run expensive enough to actually hit it end-to-end. */
export function __centroidCacheSize(): number {
  return centroidCache.size;
}

/** Test-only: exercise the LRU insert path without a DB or a model behind it. */
export function __primeCentroidCacheForTest(ownerId: string, fingerprint: string, centroid: number[]): void {
  rememberCentroid(ownerId, fingerprint, centroid);
}

/**
 * Average `titles` into one unit-less centroid vector, or null when the vectors don't
 * agree on a dimension.
 *
 * The all-or-nothing dimension check is the same doctrine as the pool cap: one short or
 * empty vector would poison the centroid with NaN — shipping "N": null on every pick AND
 * silently deleting N from the learning corpus — or hand one candidate a free N=0.5
 * outlier from a degenerate cosine.
 */
async function buildCentroid(
  titles: readonly string[],
  embed: (text: string, signal?: AbortSignal) => Promise<number[]>,
  signal: AbortSignal,
): Promise<number[] | null> {
  const vecs = await Promise.all(titles.map((t) => embed(t, signal)));
  const dim = vecs[0]?.length ?? 0;
  if (!dim || vecs.some((v) => v.length !== dim)) return null;
  const centroid = new Array<number>(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) centroid[i] += v[i] / vecs.length;
  return centroid;
}

// ── Time of day + day of week (v2.3, design §3.2/§3.3) ────────────────────────

/**
 * The app already has ONE time-of-day vocabulary: quick-add's `timeOfDay`
 * (agents/rubric.ts TIME_OF_DAY_RUBRIC / TIME_OF_DAY_VALUES) with the concrete hour
 * boundaries the client's gap-finder narrows to (client/src/lib/propose-slot.ts
 * BAND_WINDOWS: 05–12 / 12–17 / 17–22). Reused verbatim rather than invented, so a
 * histogram-derived "evening" here means the same stretch of clock the owner already
 * sees when quick-add says "evening".
 */
export type TimeBand = 'morning' | 'afternoon' | 'evening';

const BAND_MORNING_FROM_HOUR = 5;
const BAND_AFTERNOON_FROM_HOUR = 12;
const BAND_EVENING_FROM_HOUR = 17;

/**
 * BAND_WINDOWS leaves 22:00–05:00 unnamed (nothing is *proposed* at 03:00), but a
 * histogram over real completions must be TOTAL — an owner who closes tasks at
 * midnight has to land somewhere. Late night is the tail of the evening, not the head
 * of the morning, so it folds into `evening`; that also keeps the mapping monotone in
 * local wall time within a waking day.
 */
export function bandOfLocalHour(hour: number): TimeBand {
  if (hour < BAND_MORNING_FROM_HOUR) return 'evening';
  if (hour < BAND_AFTERNOON_FROM_HOUR) return 'morning';
  if (hour < BAND_EVENING_FROM_HOUR) return 'afternoon';
  return 'evening';
}

/** Afternoon is adjacent to both ends and is therefore NEVER the opposite of anything —
 *  only morning⇄evening is a genuine wrong-end-of-the-day mismatch. */
const OPPOSITE_BAND: Record<TimeBand, TimeBand | null> = {
  morning: 'evening',
  afternoon: null,
  evening: 'morning',
};

/** The band a UTC instant falls in, read on the OWNER's clock. A UTC hour is not the
 *  owner's morning — the documented Docker shape is a UTC container with a non-UTC
 *  owner, so that is the default configuration, not an exotic one. */
export function localBand(utcISO: string, tz: string): TimeBand {
  return bandOfLocalHour(Number(utcToZonedWallTime(utcISO, tz).slice(0, 2)));
}

/** Weekday 0–6 (Sun–Sat) of a UTC instant on the owner's calendar. Goes through the
 *  owner-tz local DATE and then the noon-UTC pivot (lib/tz.ts isoWeekKey's idiom), so
 *  it is DST-safe and never the server's day. */
export function localDow(utcISO: string, tz: string): number {
  return new Date(`${localDateInTZ(utcISO, tz)}T12:00:00Z`).getUTCDay();
}

// (No weekend predicate here on purpose. The weekday pairing has no −1 arm, and a
// hardcoded Sat/Sun would have contradicted `day_type`, which honours the owner's
// editable day_of_week_map — two definitions of "weekend" inside one dot product.)

/**
 * Same-class completions needed before a candidate claims a modal band or weekday.
 *
 * 3 is the smallest sample where "most often" can outvote a single stray observation
 * (2–1); at 2 the mode is either a coincidence or a tie, and at 1 it is a single data
 * point wearing the word "usually". Deliberately the same floor in both dimensions —
 * a number the owner never sees but that decides whether we claim to know their
 * rhythm should not mean two different things in two adjacent lines of code.
 */
const MODAL_MIN_SAMPLE = 3;

/**
 * How loudly the two temporal pairings (§3.2/§3.3) may speak inside `contextFit`.
 *
 * Half, not one. Every other pair there is gated by a situation dim that reads 0 most
 * of the time; these fire on nearly every call, and there are two of them, so at full
 * weight they dominated F by construction rather than by evidence. Half keeps a matched
 * rhythm meaningful without letting "you usually do this on a Wednesday evening"
 * outvote the category-deficit pull that makes Triality a Balance feature at all.
 */
const TEMPORAL_PAIR_WEIGHT = 0.5;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActionKind = 'task' | 'routine' | 'flight' | 'template';

export interface Candidate {
  kind: ActionKind;
  ref: string;
  title: string;
  estimateMin: number | null;
  direction: string | null;      // owner's direction-tag name (Work/Home/Community), lowercased
  categories: string[];          // Balance-dimension names, lowercased
  motivation: 'me' | 'us' | 'them' | null;
  /**
   * When the owner USUALLY does this class of action, derived from their own
   * completions (v2.3 §3.2/§3.3) — not declared, not guessed.
   *
   * OPTIONAL because they are derived AFTER collection: `collectCandidates` runs before
   * the history scan, so a freshly collected Candidate legitimately has neither. Absent
   * and null mean the same thing to every reader — "no honest mode" — which becomes a
   * candidate-side 0 in `contextFit` and therefore contributes nothing at all.
   */
  modalBand?: TimeBand | null;
  modalDow?: number | null;      // 0–6, Sun–Sat, on the owner's calendar
}

/** Which level of the lexicographic key `[dot, S, ref]` separated the winner from the
 *  runner-up — the vocabulary services/triality-confidence.ts reports margin in. */
export type MarginBasis = 'uncontested' | 'dot' | 'score' | 'tie';

/**
 * How this pick won its slot. DESCRIPTIVE ONLY: raw numbers the stage-4 loop already
 * computed, captured once the winner is fixed. This module derives no band, no component
 * and no basis from them — services/triality-confidence.ts does, and nothing here imports
 * it. The one-way import graph IS the "confidence never feeds ranking" guarantee.
 *
 * `score` is the UNROUNDED slotScore the comparison key used, never `scores.total`
 * (round3'd below): a margin computed from the rounded total disagrees with the decision
 * the engine actually made, and can invert a genuine sub-0.001 tie into an apparent win.
 */
export interface DecisionTelemetry {
  /** Candidates this slot chose among: post-veto, post-`taken`, winner included. */
  eligible: number;
  dot: number;
  score: number;
  /** null ⇔ the winner was alone in the eligible pool — no comparison happened at all. */
  runnerUpDot: number | null;
  runnerUpScore: number | null;
}

export interface ScoredPick extends Candidate {
  slot: Slot;
  scores: { F: number; H: number; Q: number; N: number; C: number; total: number };
  ternary: [number, number, number];
  decision: DecisionTelemetry;
  /** Completions matching this candidate under `historyMatches`, raw and UNCAPPED —
   *  the evidence behind H, which confidence divides by EVIDENCE_FULL. */
  evidenceRows: number;
}

export type TrialityResult =
  | {
      refused?: undefined;
      picks: (ScoredPick | null)[];          // habitual, contextual, novel order; null = honest empty slot
      emptyReasons: Partial<Record<Slot, string>>;
      vector: SituationVector;
    }
  | { refused: 'sparse_history'; have: number; need: number };

export interface TrialityOpts {
  /** Injectable embedding fn (the possibles.ts embedFn idiom). `null` forces the
   *  categorical-only path; undefined = use Ollama when it has an embedder pulled AND
   *  answers inside the stage budget, degrade silently otherwise. An injected fn is
   *  taken at its word — the readiness gate gets asked about Ollama only.
   *
   *  `signal` carries the stage budget. Honouring it is optional — a fake that ignores
   *  it still type-checks and still works, it just cannot be cancelled — but a real
   *  embedder should pass it to its transport so an expired budget stops the work
   *  rather than merely stopping us waiting for it. */
  embedFn?: ((text: string, signal?: AbortSignal) => Promise<number[]>) | null;
  getWeightsFn?: GetWeightsFn;
}

// ── Refusal floor (§4) ────────────────────────────────────────────────────────

/** Ritual- or timer-confirmed completions in the window — ranking noise dressed
 *  as insight is exactly what this feature refuses to ship. */
export async function confirmedCompletionCount(ownerId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  return (
    (await store()
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks t
          WHERE t.owner_id = ? AND t.status = 'done' AND t.completed_at >= ?
            AND (t.completion_mood IS NOT NULL OR t.reaction_at IS NOT NULL
                 OR EXISTS (SELECT 1 FROM time_entries e WHERE e.task_id = t.id AND e.ended_at IS NOT NULL))`,
      )
      .get<{ c: number }>(ownerId, since))!
  ).c;
}

// ── Candidate collection (§4) ─────────────────────────────────────────────────

async function taskDirection(taskId: string, ownerId: string): Promise<string | null> {
  const row = await store()
    .prepare(
      `SELECT tg.name AS name FROM entity_tags et
         JOIN tags tg ON tg.id = et.tag_id AND tg.kind = 'direction' AND tg.owner_id = ?
        WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1
        LIMIT 1`,
    )
    .get<{ name: string }>(ownerId, taskId);
  return row ? row.name.toLowerCase() : null;
}

/** A direction-kind tag name → lowercased, or null (patterns/templates store a
 *  free-text `tag` that is only a direction when it names one). */
async function directionIfDirectionTag(name: string | null, ownerId: string): Promise<string | null> {
  if (!name) return null;
  const row = await store()
    .prepare(`SELECT 1 FROM tags WHERE owner_id = ? AND kind = 'direction' AND LOWER(name) = LOWER(?)`)
    .get(ownerId, name);
  return row ? name.toLowerCase() : null;
}

async function collectCandidates(ownerId: string, now: Date): Promise<Candidate[]> {
  const out: Candidate[] = [];

  const staged = new Set(
    (await store()
      .prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ? AND selected = 1`)
      .all<{ task_id: string }>(ownerId)).map((r) => r.task_id),
  );

  // Open tasks — dependency-blocked ones excluded (a blocked pick is not an
  // action the owner can take now, so it must never survive to scoring), and
  // DEFERRED ones excluded for a stronger reason: `defer_until` is the owner
  // explicitly saying "not until then". The rest of the app honors that by
  // hiding the task from the today-set; surfacing it as a *suggestion* would
  // contradict an instruction they gave, which is worse than merely listing it.
  // Priority-ordered, bounded: POOL_CAP is a documented bound, logged when hit.
  const taskRows = await store()
    .prepare(
      `SELECT t.id, t.title, t.estimated_minutes, t.motivation FROM tasks t
        WHERE t.owner_id = ? AND t.status IN ('open', 'scheduled') AND t.parent_id IS NULL
          AND (t.defer_until IS NULL OR t.defer_until <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies d
              JOIN tasks b ON b.id = d.depends_on_id
             WHERE d.task_id = t.id AND b.status NOT IN ('done', 'cancelled'))
        ORDER BY t.priority ASC, t.id ASC
        LIMIT ${POOL_CAP + 1}`,
    )
    .all<{ id: string; title: string; estimated_minutes: number | null; motivation: Candidate['motivation'] }>(ownerId, now.toISOString());
  if (taskRows.length > POOL_CAP) {
    logger.info('triality: open-task pool capped', { ownerId, cap: POOL_CAP });
    taskRows.length = POOL_CAP;
  }
  for (const t of taskRows) {
    out.push({
      kind: staged.has(t.id) ? 'flight' : 'task',
      ref: t.id,
      title: t.title,
      estimateMin: t.estimated_minutes,
      direction: await taskDirection(t.id, ownerId),
      categories: (await entityCategoryNames('task', t.id)).map((c) => c.toLowerCase()),
      motivation: t.motivation,
    });
  }

  // Routines (pattern type 'Routine') with ≥1 open member task: the routine is
  // offered as one unit; estimate = sum of open members (15m fallback per member,
  // the quick-task default). Patterns carry no entity_categories/motivation —
  // those template dims stay honestly empty.
  const routines = await store()
    .prepare(
      `SELECT p.id, p.name, p.tag,
              SUM(COALESCE(t.estimated_minutes, 15)) AS est
         FROM patterns p
         JOIN pattern_types pt ON pt.id = p.type_id AND LOWER(pt.name) = 'routine'
         JOIN pattern_tasks m ON m.pattern_id = p.id
         JOIN tasks t ON t.id = m.task_id AND t.status = 'open'
        WHERE p.owner_id = ?
        GROUP BY p.id, p.name, p.tag`,
    )
    .all<{ id: string; name: string; tag: string | null; est: number }>(ownerId);
  for (const r of routines) {
    out.push({
      kind: 'routine',
      ref: r.id,
      title: r.name,
      estimateMin: r.est,
      direction: await directionIfDirectionTag(r.tag, ownerId),
      categories: [],
      motivation: null,
    });
  }

  // Saved block templates: a known, reusable shape of time — the classic Novel
  // candidate (no completion trail → H = 0, honestly).
  const templates = await store()
    .prepare(`SELECT id, name, tag, default_minutes FROM block_templates WHERE owner_id = ?`)
    .all<{ id: string; name: string; tag: string | null; default_minutes: number | null }>(ownerId);
  for (const b of templates) {
    out.push({
      kind: 'template',
      ref: b.id,
      title: b.name,
      estimateMin: b.default_minutes ?? 60,
      direction: await directionIfDirectionTag(b.tag, ownerId),
      categories: [],
      motivation: null,
    });
  }

  return out;
}

// ── Capacity: the raw free gap (minutes) ──────────────────────────────────────
// Mirrors the vector's free_gap SOURCE (locked/meeting blocks after now, owner-tz
// today) but keeps the raw minutes the ternary dim deliberately discards — the
// hard filter needs numbers, not signs. null = no calendar signal (filter can't
// honestly drop anything; the C term goes neutral).

export async function rawFreeGapMinutes(ownerId: string, now: Date): Promise<number | null> {
  const tz = await ownerTimezone(ownerId);
  const today = localDateInTZ(now.toISOString(), tz);
  const rows = await store()
    .prepare(
      `SELECT start_at FROM time_blocks
        WHERE owner_id = ? AND start_at > ? AND (is_locked = 1 OR block_kind = 'meeting')
        ORDER BY start_at ASC LIMIT 8`,
    )
    .all<{ start_at: string }>(ownerId, now.toISOString());
  const next = rows.find((r) => localDateInTZ(r.start_at, tz) === today);
  if (!next) return null;
  return Math.max(0, Math.round((Date.parse(next.start_at) - now.getTime()) / 60_000));
}

// ── Component scores (§5) ─────────────────────────────────────────────────────

/** Signature class for H/Q: what "this kind of action" means (§5) — kind +
 *  direction + sorted category set. */
export function signature(c: Pick<Candidate, 'kind' | 'direction' | 'categories'>): string {
  return `${c.kind}|${c.direction ?? ''}|${[...c.categories].sort().join(',')}`;
}

/** Exported because evidence (v2.2 confidence) counts the very rows H sums. */
export interface CompletionRow {
  id: string;
  completed_at: string;
  sig: string;
  pattern_ids: string[];
  /** The row's own direction — the level-2 back-off class (§3.4), kept beside `sig`
   *  rather than re-parsed out of it (the delimiter is a display detail, not an API). */
  direction: string | null;
  /** When this happened on the OWNER's clock and calendar, resolved once here so the
   *  per-candidate histograms are a pure count and the tz conversion happens |history|
   *  times rather than |history| × |candidates| times. */
  band: TimeBand;
  dow: number;
}

/**
 * The ONE definition of "this history row is an instance of this candidate".
 *
 * H weights these rows by recency and normalizes by the pool max; v2.2's `evidence`
 * just counts them. Two consumers, one predicate, evaluated in the SAME pass — a
 * divergence would make "the evidence behind H" a false claim rather than a measurable
 * one. That is the PENDING_MS lesson (triality-learning.ts) applied before the fact
 * rather than after it.
 */
export function historyMatches(c: Candidate, h: CompletionRow): boolean {
  return c.kind === 'routine'
    ? h.pattern_ids.includes(c.ref)
    : c.kind !== 'template' && h.sig === signature({ ...c, kind: 'task' });
}

/** The owner's completion history in the window, each with its signature —
 *  one scan feeds H, Q, and the routine special case. */
async function completionHistory(ownerId: string, now: Date, tz: string): Promise<CompletionRow[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await store()
    .prepare(
      `SELECT id, completed_at FROM tasks
        WHERE owner_id = ? AND status = 'done' AND completed_at >= ? AND completed_at <= ?
        ORDER BY completed_at ASC`,
    )
    .all<{ id: string; completed_at: string }>(ownerId, since, now.toISOString());
  // for-of, not .map: the body awaits, and an async map callback would return an
  // array of promises that every downstream scorer would then read as objects.
  const out: CompletionRow[] = [];
  for (const r of rows) {
    const dir = await taskDirection(r.id, ownerId);
    const cats = (await entityCategoryNames('task', r.id)).map((c) => c.toLowerCase());
    const patterns = (
      await store().prepare(`SELECT pattern_id FROM pattern_tasks WHERE task_id = ?`).all<{ pattern_id: string }>(r.id)
    ).map((p) => p.pattern_id);
    out.push({
      id: r.id,
      completed_at: r.completed_at,
      sig: signature({ kind: 'task', direction: dir, categories: cats }),
      pattern_ids: patterns,
      direction: dir,
      band: localBand(r.completed_at, tz),
      dow: localDow(r.completed_at, tz),
    });
  }
  return out;
}

/**
 * The MODE of a set of observations, or null when there is no honest one.
 *
 * Two ways to have none, and both matter: fewer than MODAL_MIN_SAMPLE observations
 * (too little to call anything usual), or a top bucket that does not STRICTLY beat the
 * runner-up. The strictness is what keeps this deterministic without a tie-break rule:
 * three completions on three different weekdays describe no weekly rhythm, and picking
 * the numerically smallest one would invent a pattern out of insertion order.
 */
function strictMode<T extends string | number>(values: readonly T[]): T | null {
  if (values.length < MODAL_MIN_SAMPLE) return null;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let top: T | null = null;
  let topN = 0;
  let secondN = 0;
  for (const [v, n] of counts) {
    if (n > topN) { secondN = topN; top = v; topN = n; }
    else if (n > secondN) secondN = n;
  }
  return topN > secondN ? top : null;
}

/**
 * TODO(triality v2.4): a STATED band should beat the histogram (§3.2) — if the owner
 * said "evening", that outranks whatever their completions happen to show. It is not
 * wired here because there is nowhere to read it from: `ParsedQuick.timeOfDay`
 * (engine/quickadd.ts) is PREVIEW-ONLY — no column on tasks, nothing persisted by the
 * quick-add merge or the wizard. Closing the gap is persistence plumbing (a migration
 * plus both write paths plus the wizard), which is a different change from v2.3's pure
 * computation; when it lands, `modalTiming` gains a stated override and this comment
 * goes away with it.
 */
/** The candidate's modal band/weekday over its OWN signature-class completions —
 *  `historyMatches` again, so "this class" means exactly what it means for H and for
 *  evidence, and a routine's rhythm comes from its members' completions. */
function modalTiming(
  c: Candidate,
  history: readonly CompletionRow[],
  now: Date,
): Pick<Candidate, 'modalBand' | 'modalDow'> {
  // RECENCY-WEIGHTED, on the same half-life H uses. An unweighted histogram over 90 days
  // lets an ABANDONED rhythm outvote the current one — and because morning⇄evening is an
  // opposition, that stale mode does not merely fail to help, it fires −1 against what
  // the owner actually does now. Someone who moved their run from morning to evening six
  // weeks ago would have H saying "this is your habit" and F saying "wrong end of your
  // day", from the same rows, because only one of the two respected recency.
  const bands = new Map<TimeBand, number>();
  const dows = new Map<number, number>();
  let matches = 0;
  for (const h of history) {
    if (!historyMatches(c, h)) continue;
    matches++;
    const w = recencyWeight(h.completed_at, now);
    bands.set(h.band, (bands.get(h.band) ?? 0) + w);
    dows.set(h.dow, (dows.get(h.dow) ?? 0) + w);
  }
  if (matches < MODAL_MIN_SAMPLE) return { modalBand: null, modalDow: null };
  return { modalBand: strictWeightedMode(bands), modalDow: strictWeightedMode(dows) };
}

/** The single heaviest bucket, or null on a tie — a tie is not a rhythm. Iteration is
 *  over insertion order, which is history order, so the result is deterministic. */
function strictWeightedMode<T>(weights: ReadonlyMap<T, number>): T | null {
  let best: T | null = null;
  let bestW = 0;
  let tied = false;
  for (const [k, w] of weights) {
    if (w > bestW + 1e-9) { best = k; bestW = w; tied = false; }
    else if (Math.abs(w - bestW) <= 1e-9) tied = true;
  }
  return tied ? null : best;
}

/** Recency weight: 2^(-ageDays / half-life). */
function recencyWeight(completedAt: string, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(completedAt)) / 86_400_000);
  return Math.pow(2, -ageDays / HALF_LIFE_DAYS);
}

/**
 * H per candidate: the recency-weighted completion frequency of its signature class
 * (half-life 14d), normalized by the pool max so H lands in [0,1].
 *
 * v2.3 ATTEMPTED an interpolated back-off here (§3.4) — blending a (kind, direction)
 * level in so a novel signature in a frequent direction would not score a flat 0. It
 * was REVERTED, and the reason is worth keeping so nobody rebuilds it the same way:
 *
 *  - The coarse levels are TAUTOLOGICAL under pool-max normalization. Every task
 *    completion matches (kind = task), so a level-1 strength is identically 1.0 for
 *    everybody, and a never-before-seen task took the entire residual mass against
 *    that 1 — scoring as the owner's strongest habit. The same holds at level 2
 *    whenever the direction is null, which is most owners.
 *  - Worse, normalizing each level by ITS OWN pool max makes the blend NON-MONOTONE.
 *    h2 sits near 1.0 for anyone in the busiest direction while h3 is far below it, so
 *    shifting mass toward the SPECIFIC level shifts it toward the SMALLER number. An
 *    adversarial search found H strictly DECREASING in completion count across ~7% of
 *    same-direction pairs: a candidate lost habit strength by being done more often.
 *
 * Both are properties of the NORMALIZATION, not of the code that implemented it, so a
 * future back-off has to answer "in what units are these levels commensurable?" first
 * — blending raw recency masses and normalizing once is the obvious candidate. Until
 * then §1's direction-frequency gap stands open, which is the honest state.
 *
 * OLD NOTE, kept because it still explains why level 1 can never simply be added:
 * honest ZERO instead. The design's third level is (kind) alone — but on the task path
 * that class is TAUTOLOGICAL: every completion in the window is a task, so every task
 * candidate matches all of them, and a pool-max-normalized level-1 strength is
 * identically 1.0 for everybody. Blending that in would hand a never-before-seen task
 * the ENTIRE residual mass against a value of 1 (λ3 = λ2 = 0 ⇒ H = 1) and score it as
 * the owner's single strongest habit — the exact inversion the back-off exists to fix.
 * The same argument retires the level-2 pairing for a candidate with NO direction: a
 * null direction matches every null-direction completion, so "I know nothing about you"
 * would again read as maximal habit. An unknown coarse class is unsensed, not
 * confirmed, so it contributes nothing — the same rule contextFit already applies to a
 * null direction and that Decision 1 applies to an unknown modal band.
 *
 * Routines match by MEMBERSHIP and templates have no completion trail at all, so a
 * template scores exactly 0 — honestly, not accidentally.
 *
 * `classStrengths` is the same value under the name novelty uses for it (N = 1 − it),
 * and `counts` is the unweighted match count, which is what v2.2's evidence term
 * qualifies H with. The two must always describe the SAME rows.
 */
function habitStrengths(
  cands: Candidate[],
  history: CompletionRow[],
  now: Date,
): { strengths: number[]; classStrengths: number[]; counts: number[] } {
  const counts: number[] = [];
  const raw3: number[] = [];

  for (const c of cands) {
    let sum3 = 0, k3 = 0;
    for (const h of history) {
      if (historyMatches(c, h)) { sum3 += recencyWeight(h.completed_at, now); k3++; }
    }
    counts.push(k3);
    raw3.push(sum3);
  }

  const max3 = Math.max(...raw3, 0);
  const classStrengths = raw3.map((v) => (max3 > 0 ? v / max3 : 0));

  // H IS the level-3 class strength. `strengths` and `classStrengths` are the same
  // numbers today; both are returned because callers mean different things by them
  // (H ranks, classStrengths defines novelty) and the v2.3 attempt to make them
  // diverge is what had to be reverted — see the header.
  return { strengths: classStrengths, classStrengths, counts };
}

/** Q: first-order transition frequency — of all historical (prev → next)
 *  completion pairs, how often did the candidate's class follow the class of
 *  the owner's MOST RECENT completion? No history → 0 across the board. */
function sequenceFits(cands: Candidate[], history: CompletionRow[]): number[] {
  if (history.length < 2) return cands.map(() => 0);
  const lastSig = history[history.length - 1].sig;
  const counts = new Map<string, number>();
  let fromLast = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i - 1].sig !== lastSig) continue;
    fromLast++;
    counts.set(history[i].sig, (counts.get(history[i].sig) ?? 0) + 1);
  }
  if (fromLast === 0) return cands.map(() => 0);
  return cands.map((c) => {
    if (c.kind === 'routine' || c.kind === 'template') return 0; // no task-signature identity
    return (counts.get(signature({ ...c, kind: 'task' })) ?? 0) / fromLast;
  });
}

/** Cosine distance, SQUASHED (`/2 + 0.25`) and clamped into [0.25, 1] — higher = more
 *  novel, and deliberately never saturating at 0 so no candidate gets a free extreme.
 *  A zero-norm vector yields 1 (maximally novel). NOT `1 − groom's cosineSimilarity()`:
 *  the squash means this is not the complement of any plain cosine. */
function squashedCosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return Math.min(1, Math.max(0, (1 - dot / Math.sqrt(na * nb)) / 2 + 0.25)); // squashed to avoid saturating
}

/**
 * N: categorical novelty (1 − H_class), blended 50/50 with embedding-centroid
 * distance when embeddings answer. Ollama down, no embedder pulled, or no embedFn ⇒
 * categorical only — never blocks, never throws past this frame.
 *
 * `classStrengths` — the LEVEL-3 value — not the blended H, and the parameter is named
 * for it so the two can never be swapped by accident. Novelty asks "is this exact kind
 * of thing unfamiliar", and the v2.3 back-off deliberately borrows strength from the
 * candidate's DIRECTION: feeding the blend in here would let a genuinely new
 * combination look familiar merely because its direction is common, which is the one
 * thing the Novel slot exists to catch. Back-off informs the SCORE, never the novelty.
 */
async function noveltyScores(
  cands: Candidate[],
  classStrengths: number[],
  ownerId: string,
  now: Date,
  embedFn: TrialityOpts['embedFn'],
): Promise<number[]> {
  const categorical = classStrengths.map((h) => 1 - h);
  // Explicit short per-call timeout: inheriting ollama.embed's 30s default put a
  // 30-second-per-title ceiling on a request the banner is waiting for.
  const embed = embedFn === null ? null : embedFn ?? (async (t: string, signal?: AbortSignal) => ollama.embed(t, EMBED_TIMEOUT_MS, signal));
  if (!embed) return categorical;

  try {
    // Readiness gate on the DEFAULT embedder only — an injected embedFn is the caller's
    // business, and the fakes the engine tests drive this stage with must still run.
    //
    // Load-bearing, not tidying. This was the one model call in the request path with no
    // availability check, and combined with the budget below that made N a COIN FLIP
    // whenever Ollama was reachable-but-busy: the same request answered twice a second
    // apart returned a blended N one time and a categorical N the next — a different
    // confidence on the wire and a different score blob in the learning corpus for an
    // identical situation. Asked BEFORE the budget rather than left to the fallback
    // because "the embedder isn't there" and "the embedder was slow today" must not be
    // the same observable event. INSIDE the try like every other line here: this frame
    // is the one that owes callers "never throws".
    //
    // debug, not info, unlike the two bounded-skip logs below: those are anomalies, this
    // is the steady state on any box with no embedder pulled — one line per request.
    if (embedFn === undefined && !(await ollama.embedReady(ownerId))) {
      logger.debug('triality: no embedder installed — categorical novelty only', { ownerId });
      return categorical;
    }

    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    const recent = await store()
      .prepare(
        `SELECT title FROM tasks WHERE owner_id = ? AND status = 'done' AND completed_at >= ?
          ORDER BY completed_at DESC LIMIT ?`,
      )
      .all<{ title: string }>(ownerId, since, CENTROID_TITLES);
    if (recent.length < 5) return categorical; // too little signal for a meaningful centroid

    // Cache lookup on the DEFAULT embedder only, matching the readiness gate above: an
    // injected embedFn is the caller's business, and a test that hands in a counting or
    // failing fake must see every call it expects rather than a vector this process
    // happened to remember from an earlier case.
    const titles = recent.map((r) => r.title);
    const fingerprint =
      embedFn === undefined ? centroidFingerprint(await resolveEmbedModel(ownerId), titles) : null;
    const reusable = fingerprint ? cachedCentroidFor(ownerId, fingerprint) : null;

    // A pool bigger than the cap is not embedded AT ALL, rather than partially:
    // a half-embedded pool would rank some candidates on blended novelty and the
    // rest on categorical, which is not a ranking — it is two rankings interleaved.
    if (cands.length > EMBED_CANDIDATE_CAP) {
      logger.info('triality: candidate pool over embed cap — categorical novelty only', {
        ownerId, pool: cands.length, cap: EMBED_CANDIDATE_CAP,
      });
      return categorical;
    }

    // ONE wall-clock budget for the whole stage, and the fallback is all-or-nothing
    // for the same reason. Embeddings are the only I/O in the scoring path, and
    // `ollama.embed`'s own default is 30s PER CALL — with a centroid plus one call
    // per candidate that is an unbounded stall on a reachable-but-slow Ollama, on
    // a request a human is waiting on. Racing the entire stage against one deadline
    // makes the worst case bounded and the outcome shape deterministic.
    // The budget CANCELS the work it walks away from; losing the race is not enough.
    //
    // Racing bounds the caller's latency. It does not bound the load, and on this stage
    // those came apart badly: every abandoned run left up to 25 centroid embeds plus one
    // per candidate still executing against Ollama, to their own per-call ceilings, for
    // results already thrown away. That is worse than waste — it is a feedback loop. A
    // busy Ollama makes the budget more likely to blow, and each blown budget adds a
    // fresh pile of orphaned embeddings that keeps it busy, so a refreshing user drives
    // it further from recovery. Cancelling makes the timeout SHED load instead of hiding it.
    const budget = new AbortController();
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const blended = await Promise.race([
      (async () => {
        // A reused centroid costs zero embeddings; only a miss pays for the 25.
        const centroid = reusable ?? (await buildCentroid(titles, embed, budget.signal));
        if (!centroid) return null;
        // Store only a FULLY built, dimension-validated centroid — never a partial one,
        // and never one from a run the budget cancelled (buildCentroid rejects there, so
        // this line is not reached).
        if (!reusable && fingerprint) rememberCentroid(ownerId, fingerprint, centroid);

        // Parallel, not sequential: the cap bounds the fan-out, and serial awaits
        // multiplied the latency by the pool size for no benefit.
        const cvecs = await Promise.all(cands.map((c) => embed(c.title, budget.signal)));
        // Candidates must live in the centroid's space. A cached centroid cannot be from
        // another model (the fingerprint covers it), but a candidate vector can still
        // come back the wrong length from a half-swapped embedder.
        if (cvecs.some((v) => v.length !== centroid.length)) return null;
        return cvecs.map(
          (v, i) => EMBED_BLEND * categorical[i] + (1 - EMBED_BLEND) * squashedCosineDistance(v, centroid as number[]),
        );
      })(),
      new Promise<null>((resolve) => {
        budgetTimer = setTimeout(() => resolve(null), NOVELTY_BUDGET_MS);
      }),
    ]).finally(() => {
      // The timer is CLEARED on the fast path — an uncleared 4s timeout per request
      // held vitest workers open and added a measurable tail to graceful shutdown.
      clearTimeout(budgetTimer);
      // Abort on EVERY exit, not just the timeout. A rejected `Promise.all` settles the
      // race while its siblings are still in flight, so the fast-fail path orphaned
      // embeddings too. Once this stage is over nothing it started may still be running;
      // when the work finished normally this is a no-op.
      budget.abort();
    });
    // A cancelled embed rejects, and that rejection lands on a race that has already
    // settled — `Promise.race` keeps its handlers attached to every input, so it is
    // observed and discarded rather than surfacing as an unhandled rejection.
    if (!blended) {
      logger.info('triality: novelty embedding budget exceeded — categorical only', { ownerId, budgetMs: NOVELTY_BUDGET_MS });
      return categorical;
    }
    return blended;
  } catch (err) {
    logger.info('triality: embeddings unavailable — categorical novelty only', { err: (err as Error).message });
    return categorical;
  }
}

/**
 * F: the dot product (§1/§5) — situation dims paired with action-template dims,
 * normalized over pairs where BOTH sides are non-zero, rescaled [−1,1] → [0,1].
 * No active pairs ⇒ 0.5 (neutral): an unsensed boundary argues neither way.
 */
export function contextFit(vector: SituationVector, c: Candidate, now: Date, tz: string): number {
  const d = vector.dims;
  const pairs: Array<[number, number]> = [];

  // Motivation: situation drift × the candidate's polarity (me +1 / us,NULL 0 / them −1).
  const mot = c.motivation === 'me' ? 1 : c.motivation === 'them' ? -1 : 0;
  pairs.push([d.motivation_balance ?? 0, mot]);

  // Category deficits: an under-served category (+1) pairs with a candidate that
  // carries it (+1) — the §6 pull, no special cases.
  for (const key of Object.keys(d)) {
    if (!key.startsWith('cat_deficit_')) continue;
    const cat = key.slice('cat_deficit_'.length);
    pairs.push([d[key as keyof typeof d] ?? 0, c.categories.includes(cat) ? 1 : 0]);
  }

  // Energy: low energy (−1) pairs against big estimates; small ones fit (+1).
  const energyFit = c.estimateMin == null ? 0 : c.estimateMin <= 30 ? 1 : c.estimateMin >= 90 ? -1 : 0;
  pairs.push([d.day_energy ?? 0, energyFit]);

  // Work alignment: a Work-direction action belongs inside work hours / work-typed
  // days; Home/Community lean the other way. No direction ⇒ no pairing.
  const workAlign = c.direction === 'work' ? 1 : c.direction ? -1 : 0;
  pairs.push([d.in_work_hours ?? 0, workAlign]);
  pairs.push([d.day_type ?? 0, workAlign]);

  // ── Time of day and day of week (v2.3 §3.2/§3.3) ────────────────────────────
  //
  // WHY THESE ARE PAIRINGS AND NOT SITUATION DIMS — the next reader will wonder.
  //
  // The vector's contract is BALANCED TERNARY. "It is afternoon" is a 3-way fact and
  // "it is Tuesday" a 7-way one; neither is ternary, and neither has an honest −1.
  // Worse, a dim meaning "we know what time it is" would read +1 for every owner on
  // every call, which would inflate v2.2's coverage (non-zero active dims ÷ active
  // dims) without one byte of new SENSING — confidence would read higher while we knew
  // exactly as much. So the vector is untouched and both signals enter here instead.
  //
  // Situation side is a constant +1: the clock and the calendar are ALWAYS known, which
  // is precisely why they make a poor dim and a good pairing. The candidate side does
  // all the work, and `active` below drops any pair whose candidate side is 0 — so a
  // candidate with no rhythm of its own contributes nothing rather than a guessed zero.
  const bandFit =
    c.modalBand == null ? 0
      : c.modalBand === localBand(now.toISOString(), tz) ? 1
      : OPPOSITE_BAND[c.modalBand] === localBand(now.toISOString(), tz) ? -1
      : 0;
  // SUB-UNIT WEIGHT, deliberately. Every other pair here is gated by a sensed situation
  // dim that is 0 most of the time; these two fire on almost every call, and there are
  // two of them. At full weight they became the loudest terms in F by construction — a
  // weekday-shaped owner opening the app on a Saturday got both arms firing −1 at once,
  // which drove F below the neutral 0.5 that a candidate with NO history keeps, i.e. the
  // engine systematically preferred things the owner had never done. They modulate; they
  // do not decide.
  pairs.push([TEMPORAL_PAIR_WEIGHT, bandFit]);

  // Weekday: +1 on the same weekday, 0 otherwise. There is NO −1 arm, and that asymmetry
  // is the point: "she usually does this on a Wednesday and today is Saturday" is an
  // ABSENCE OF SUPPORT, not evidence against — unlike the band, where morning-vs-evening
  // is a genuine opposition. A −1 here also silently re-hardcoded Sat/Sun as the weekend
  // while `day_type`, eight lines above, honours the owner-editable week map; dropping
  // the arm removes the contradiction rather than papering over it.
  const nowDow = localDow(now.toISOString(), tz);
  const dowFit = c.modalDow != null && c.modalDow === nowDow ? 1 : 0;
  pairs.push([TEMPORAL_PAIR_WEIGHT, dowFit]);

  const active = pairs.filter(([s, a]) => s !== 0 && a !== 0);
  if (active.length === 0) return 0.5;
  const dot = active.reduce((acc, [s, a]) => acc + s * a, 0) / active.length;
  return (dot + 1) / 2;
}

/** C: comfort margin within the raw gap, halved for big work on empty batteries.
 *  Unknown gap or estimate ⇒ 0.5 (neutral, not confident). */
function capacityScore(c: Candidate, gapMin: number | null, dayEnergy: number): number {
  let score: number;
  if (gapMin == null || c.estimateMin == null) score = 0.5;
  else if (c.estimateMin > gapMin) score = 0;
  else score = Math.min(1, (gapMin - c.estimateMin) / Math.max(gapMin, 1) + 0.25);
  if (dayEnergy === -1 && (c.estimateMin ?? 0) > 30) score *= 0.5;
  return score;
}

// ── Ternary triple + slot assignment (§5) ─────────────────────────────────────

/** The slot-assignment comparison key: dot desc, S desc, ref asc. */
type PickKey = [number, number, string];

/**
 * ONE comparator, used for both the winner and the runner-up.
 *
 * Extracted verbatim from the inline expression it replaces — deliberately not
 * "improved" — because v2.2's runner-up must be the second-best under exactly the
 * ordering that chose the winner. Two implementations of this predicate is how a
 * reported margin quietly stops describing the decision it claims to describe.
 */
const keyBetter = (a: PickKey, b: PickKey | null): boolean =>
  !b || a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));

/**
 * Ternarization by VALUE SPREAD, not rank: top third of the pool's value range
 * → +1, bottom third → −1. Ties always share a band (rank-thirds would split
 * identical scores arbitrarily, making the slot dot products depend on insert
 * order — the opposite of deterministic honesty), and a pool with no spread
 * (all equal, incl. singletons) ternarizes to all-0: nothing differentiates,
 * so nothing should claim a pole.
 */
function ternarize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  if (!(spread > 1e-9)) return values.map(() => 0);
  const lo = min + spread / 3;
  const hi = max - spread / 3;
  return values.map((v) => (v >= hi ? 1 : v <= lo ? -1 : 0));
}

// ── Log helpers (T4/T5 wire these; nothing calls them inside the engine) ──────

export async function logShown(
  ownerId: string,
  now: Date,
  picks: (ScoredPick | null)[],
  /**
   * Pre-serialized confidence blobs (0144), parallel to `picks`.
   *
   * DELIBERATELY OPAQUE. A typed parameter would force this module to import
   * services/triality-confidence.ts, and the one-way import graph — the whole of the
   * "confidence never feeds ranking" guarantee — would be traded away for ergonomics
   * in a persistence helper. Nothing here interprets the string.
   *
   * REQUIRED, not optional: a missed call site has to be a type error. Defaulted, it
   * would silently write NULL, and NULL is load-bearing — it means "shown before
   * v2.2" forever, and the calibration tile excludes those rows rather than banding
   * them.
   */
  confidenceJson: readonly (string | null)[],
): Promise<(string | null)[]> {
  const tz = await ownerTimezone(ownerId);
  const localDate = localDateInTZ(now.toISOString(), tz);
  const insert = store().prepare(
    `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores, confidence)
     VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  // for-of, not .map: an async callback would hand every caller a promise where it
  // expects a log id, and the ids are what stampOutcome is later keyed on.
  const ids: (string | null)[] = [];
  for (const [i, p] of picks.entries()) {
    if (!p) { ids.push(null); continue; }
    const row = (await insert.get<{ id: string }>(
      ownerId,
      now.toISOString(),
      localDate,
      p.slot,
      p.kind,
      p.ref,
      JSON.stringify({ ...p.scores, ternary: p.ternary }),
      confidenceJson[i] ?? null,
    ))!;
    ids.push(row.id);
  }
  return ids;
}

export type Outcome = 'opened' | 'staged' | 'dismissed';
const OUTCOMES: readonly Outcome[] = ['opened', 'staged', 'dismissed'];
export function isOutcome(v: unknown): v is Outcome {
  return typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v);
}

/** Append-only discipline: a row's outcome is stamped AT MOST once — the guarded
 *  UPDATE makes a second stamp (or a foreign log id) a `changed:false` no-op. */
export async function stampOutcome(ownerId: string, logId: string, outcome: Outcome, now: Date): Promise<{ changed: boolean }> {
  const res = await store()
    .prepare(
      `UPDATE triality_log SET outcome = ?, outcome_at = ?
        WHERE id = ? AND owner_id = ? AND outcome = 'shown'`,
    )
    .run(outcome, now.toISOString(), logId, ownerId);
  return { changed: res.changes > 0 };
}

// ── The pipeline ──────────────────────────────────────────────────────────────

export async function trialityNext(ownerId: string, now: Date, opts: TrialityOpts = {}): Promise<TrialityResult> {
  const have = await confirmedCompletionCount(ownerId, now);
  if (have < REFUSAL_FLOOR) return { refused: 'sparse_history', have, need: REFUSAL_FLOOR };

  const vector = await buildSituationVector(ownerId, now);
  const gapMin = await rawFreeGapMinutes(ownerId, now);
  const tz = await ownerTimezone(ownerId);

  // Stage 1 — hard capacity filter (§1: pipeline order is normative). Only a
  // KNOWN misfit drops: unknown gap or unknown estimate cannot honestly exclude.
  const all = await collectCandidates(ownerId, now);
  const fitting = all.filter(
    (c) => !(gapMin != null && c.estimateMin != null && c.estimateMin > gapMin - GAP_MARGIN_MIN),
  );
  if (fitting.length === 0) {
    return {
      picks: [null, null, null],
      emptyReasons: {
        habitual: 'no candidate fits the free time before your next fixed block',
        contextual: 'no candidate fits the free time before your next fixed block',
        novel: 'no candidate fits the free time before your next fixed block',
      },
      vector,
    };
  }

  // Stage 2 — component scores. The history scan comes first because the candidates'
  // modal band/weekday are DERIVED from it (§3.2/§3.3) — they are the owner's own
  // rhythm for this class, never a declared preference.
  const history = await completionHistory(ownerId, now, tz);
  const cands = fitting.map((c) => ({ ...c, ...modalTiming(c, history, now) }));
  const { strengths: H, classStrengths, counts: histCounts } = habitStrengths(cands, history, now);
  const Q = sequenceFits(cands, history);
  // N tracks the LEVEL-3 class, not the backed-off H — see `noveltyScores`.
  const N = await noveltyScores(cands, classStrengths, ownerId, now, opts.embedFn);
  const F = cands.map((c) => contextFit(vector, c, now, tz));
  const C = cands.map((c) => capacityScore(c, gapMin, vector.dims.day_energy ?? 0));

  // Stage 3 — ternary triple [normality, pragmatism, capacity] by pool thirds.
  const normality = ternarize(H);
  const pragmatism = ternarize(F);
  const capacity = ternarize(C);

  // Resolve each slot's weights ONCE per run (they cannot change mid-pipeline —
  // learning is batch by construction), so scoring is one table read per slot
  // rather than one per candidate, and the whole run sees a single consistent
  // weight set even if the job happened to land between two candidates.
  const weightsFor = opts.getWeightsFn ?? getWeights;
  const resolvedWeights = Object.fromEntries(
    await Promise.all(SLOTS.map(async (s) => [s, await weightsFor(ownerId, s)] as const)),
  ) as Record<Slot, SlotWeights>;
  const slotScore = (slot: Slot, i: number): number => {
    const w = resolvedWeights[slot];
    return w.F * F[i] + w.H * H[i] + w.Q * Q[i] + w.N * N[i] + w.C * C[i];
  };

  // Stage 4 — greedy exclusive assignment, habitual → contextual → novel.
  // Qualification is an AXIS VETO, not a dot floor: a candidate whose normality
  // actively opposes the slot's pole (novel work offered as Habitual, the
  // owner's top habit offered as Novel) never fills it — that's §5's empty-slot
  // honesty. But an undifferentiated pool (all-zero triples) still ranks by the
  // slot's S weights: three weak-but-real suggestions beat three empty boxes
  // when nothing actually mismatches.
  const taken = new Set<number>();
  const picks: (ScoredPick | null)[] = [];
  const emptyReasons: Partial<Record<Slot, string>> = {};

  for (const slot of SLOTS) {
    const target = TARGETS[slot];
    let eligible = 0;
    let best: number | null = null;
    let bestKey: PickKey | null = null;
    let runnerKey: PickKey | null = null;
    for (let i = 0; i < cands.length; i++) {
      if (taken.has(i)) continue;
      // Axis veto on the slot-defining normality pole (target[0]) only. Capacity
      // gets no veto: its ternary is pool-RELATIVE (thirds of the surviving
      // spread), and absolute misfits were already dropped by the hard filter —
      // vetoing relative-low C would empty slots whenever the pool is small.
      if (target[0] === 1 && normality[i] === -1) continue;   // habitual can't be their least-done class
      if (target[0] === -1 && normality[i] === 1) continue;   // novel can't be their top habit
      eligible++;
      const dot =
        target[0] * normality[i] + target[1] * pragmatism[i] + target[2] * capacity[i];
      const key: PickKey = [dot, slotScore(slot, i), cands[i].ref];
      // A displaced bestKey was the maximum of everything seen so far, so it is
      // necessarily better than the incumbent runner-up — promoted directly, with no
      // second comparison. The winner's own update is byte-identical to the pre-v2.2
      // expression (now named `keyBetter`), which is what keeps runner-up capture a
      // pure addition rather than a re-ranking.
      if (keyBetter(key, bestKey)) { runnerKey = bestKey; best = i; bestKey = key; }
      else if (keyBetter(key, runnerKey)) { runnerKey = key; }
    }
    if (best == null) {
      picks.push(null);
      emptyReasons[slot] = 'no candidate matched this slot’s profile';
      continue;
    }
    taken.add(best);
    picks.push({
      ...cands[best],
      slot,
      scores: {
        F: round3(F[best]), H: round3(H[best]), Q: round3(Q[best]),
        N: round3(N[best]), C: round3(C[best]), total: round3(slotScore(slot, best)),
      },
      ternary: [normality[best], pragmatism[best], capacity[best]],
      decision: {
        eligible,
        // Unrounded on purpose — see DecisionTelemetry.
        dot: bestKey![0],
        score: bestKey![1],
        runnerUpDot: runnerKey ? runnerKey[0] : null,
        runnerUpScore: runnerKey ? runnerKey[1] : null,
      },
      evidenceRows: histCounts[best],
    });
  }

  return { picks, emptyReasons, vector };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
