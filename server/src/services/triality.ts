import { sqlite } from '../db/index.js';
import { ollama } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';
import { localDateInTZ } from '../lib/tz.js';
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
const selectWeights = sqlite.prepare(
  `SELECT weights FROM triality_weights WHERE owner_id = ? AND slot = ?`,
);

export function getWeights(ownerId: string, slot: Slot): SlotWeights {
  // Every fallback returns a COPY: DEFAULT_WEIGHTS is exported, and handing out a
  // reference to it makes a future caller's in-place tweak a global default change.
  const defaults = () => ({ ...DEFAULT_WEIGHTS[slot] });
  const row = selectWeights.get(ownerId, slot) as { weights: string } | undefined;
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
export type GetWeightsFn = typeof getWeights;

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
   *  categorical-only path; undefined = use Ollama when it answers, degrade silently. */
  embedFn?: ((text: string) => Promise<number[]>) | null;
  getWeightsFn?: GetWeightsFn;
}

// ── Refusal floor (§4) ────────────────────────────────────────────────────────

/** Ritual- or timer-confirmed completions in the window — ranking noise dressed
 *  as insight is exactly what this feature refuses to ship. */
export function confirmedCompletionCount(ownerId: string, now: Date): number {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  return (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks t
          WHERE t.owner_id = ? AND t.status = 'done' AND t.completed_at >= ?
            AND (t.completion_mood IS NOT NULL OR t.reaction_at IS NOT NULL
                 OR EXISTS (SELECT 1 FROM time_entries e WHERE e.task_id = t.id AND e.ended_at IS NOT NULL))`,
      )
      .get(ownerId, since) as { c: number }
  ).c;
}

// ── Candidate collection (§4) ─────────────────────────────────────────────────

function taskDirection(taskId: string, ownerId: string): string | null {
  const row = sqlite
    .prepare(
      `SELECT tg.name AS name FROM entity_tags et
         JOIN tags tg ON tg.id = et.tag_id AND tg.kind = 'direction' AND tg.owner_id = ?
        WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1
        LIMIT 1`,
    )
    .get(ownerId, taskId) as { name: string } | undefined;
  return row ? row.name.toLowerCase() : null;
}

/** A direction-kind tag name → lowercased, or null (patterns/templates store a
 *  free-text `tag` that is only a direction when it names one). */
function directionIfDirectionTag(name: string | null, ownerId: string): string | null {
  if (!name) return null;
  const row = sqlite
    .prepare(`SELECT 1 FROM tags WHERE owner_id = ? AND kind = 'direction' AND LOWER(name) = LOWER(?)`)
    .get(ownerId, name);
  return row ? name.toLowerCase() : null;
}

function collectCandidates(ownerId: string, now: Date): Candidate[] {
  const out: Candidate[] = [];

  const staged = new Set(
    (sqlite.prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ? AND selected = 1`).all(ownerId) as {
      task_id: string;
    }[]).map((r) => r.task_id),
  );

  // Open tasks — dependency-blocked ones excluded (a blocked pick is not an
  // action the owner can take now, so it must never survive to scoring), and
  // DEFERRED ones excluded for a stronger reason: `defer_until` is the owner
  // explicitly saying "not until then". The rest of the app honors that by
  // hiding the task from the today-set; surfacing it as a *suggestion* would
  // contradict an instruction they gave, which is worse than merely listing it.
  // Priority-ordered, bounded: POOL_CAP is a documented bound, logged when hit.
  const taskRows = sqlite
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
    .all(ownerId, now.toISOString()) as { id: string; title: string; estimated_minutes: number | null; motivation: Candidate['motivation'] }[];
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
      direction: taskDirection(t.id, ownerId),
      categories: entityCategoryNames('task', t.id).map((c) => c.toLowerCase()),
      motivation: t.motivation,
    });
  }

  // Routines (pattern type 'Routine') with ≥1 open member task: the routine is
  // offered as one unit; estimate = sum of open members (15m fallback per member,
  // the quick-task default). Patterns carry no entity_categories/motivation —
  // those template dims stay honestly empty.
  const routines = sqlite
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
    .all(ownerId) as { id: string; name: string; tag: string | null; est: number }[];
  for (const r of routines) {
    out.push({
      kind: 'routine',
      ref: r.id,
      title: r.name,
      estimateMin: r.est,
      direction: directionIfDirectionTag(r.tag, ownerId),
      categories: [],
      motivation: null,
    });
  }

  // Saved block templates: a known, reusable shape of time — the classic Novel
  // candidate (no completion trail → H = 0, honestly).
  const templates = sqlite
    .prepare(`SELECT id, name, tag, default_minutes FROM block_templates WHERE owner_id = ?`)
    .all(ownerId) as { id: string; name: string; tag: string | null; default_minutes: number | null }[];
  for (const b of templates) {
    out.push({
      kind: 'template',
      ref: b.id,
      title: b.name,
      estimateMin: b.default_minutes ?? 60,
      direction: directionIfDirectionTag(b.tag, ownerId),
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

export function rawFreeGapMinutes(ownerId: string, now: Date): number | null {
  const tz = ownerTimezone(ownerId);
  const today = localDateInTZ(now.toISOString(), tz);
  const rows = sqlite
    .prepare(
      `SELECT start_at FROM time_blocks
        WHERE owner_id = ? AND start_at > ? AND (is_locked = 1 OR block_kind = 'meeting')
        ORDER BY start_at ASC LIMIT 8`,
    )
    .all(ownerId, now.toISOString()) as { start_at: string }[];
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
export interface CompletionRow { id: string; completed_at: string; sig: string; pattern_ids: string[] }

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
function completionHistory(ownerId: string, now: Date): CompletionRow[] {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const rows = sqlite
    .prepare(
      `SELECT id, completed_at FROM tasks
        WHERE owner_id = ? AND status = 'done' AND completed_at >= ? AND completed_at <= ?
        ORDER BY completed_at ASC`,
    )
    .all(ownerId, since, now.toISOString()) as { id: string; completed_at: string }[];
  return rows.map((r) => {
    const dir = taskDirection(r.id, ownerId);
    const cats = entityCategoryNames('task', r.id).map((c) => c.toLowerCase());
    const patterns = (
      sqlite.prepare(`SELECT pattern_id FROM pattern_tasks WHERE task_id = ?`).all(r.id) as { pattern_id: string }[]
    ).map((p) => p.pattern_id);
    return {
      id: r.id,
      completed_at: r.completed_at,
      sig: signature({ kind: 'task', direction: dir, categories: cats }),
      pattern_ids: patterns,
    };
  });
}

/** Recency weight: 2^(-ageDays / half-life). */
function recencyWeight(completedAt: string, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(completedAt)) / 86_400_000);
  return Math.pow(2, -ageDays / HALF_LIFE_DAYS);
}

/**
 * H per candidate: recency-weighted completion frequency of its signature class,
 * normalized by the pool max so the top habitual class sits at 1. Routines match
 * by MEMBERSHIP (completing any member task is doing the routine); templates
 * have no completion trail and stay 0 — honestly, not accidentally.
 *
 * `counts` is the same match, unweighted and un-normalized. It rides along rather than
 * being recomputed because the two numbers MUST describe the same rows (v2.2 evidence
 * qualifies H), and because neither is recoverable from the other: pool-max
 * normalization pins the top candidate at 1.0 whether it has 200 completions or 1.
 */
function habitStrengths(
  cands: Candidate[],
  history: CompletionRow[],
  now: Date,
): { strengths: number[]; counts: number[] } {
  const counts: number[] = [];
  const raw = cands.map((c) => {
    let sum = 0;
    let n = 0;
    for (const h of history) {
      if (!historyMatches(c, h)) continue;
      sum += recencyWeight(h.completed_at, now);
      n++;
    }
    counts.push(n);
    return sum;
  });
  const max = Math.max(...raw, 0);
  return { strengths: raw.map((v) => (max > 0 ? v / max : 0)), counts };
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

/** Cosine distance in [0,1] (1 = maximally novel). */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return Math.min(1, Math.max(0, (1 - dot / Math.sqrt(na * nb)) / 2 + 0.25)); // squashed to avoid saturating
}

/**
 * N: categorical novelty (1 − H_class), blended 50/50 with embedding-centroid
 * distance when embeddings answer. Ollama down / no embedFn ⇒ categorical only —
 * never blocks, never throws past this frame.
 */
async function noveltyScores(
  cands: Candidate[],
  H: number[],
  ownerId: string,
  now: Date,
  embedFn: TrialityOpts['embedFn'],
): Promise<number[]> {
  const categorical = H.map((h) => 1 - h);
  // Explicit short per-call timeout: inheriting ollama.embed's 30s default put a
  // 30-second-per-title ceiling on a request the banner is waiting for.
  const embed = embedFn === null ? null : embedFn ?? (async (t: string) => ollama.embed(t, EMBED_TIMEOUT_MS));
  if (!embed) return categorical;

  try {
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    const recent = sqlite
      .prepare(
        `SELECT title FROM tasks WHERE owner_id = ? AND status = 'done' AND completed_at >= ?
          ORDER BY completed_at DESC LIMIT 25`,
      )
      .all(ownerId, since) as { title: string }[];
    if (recent.length < 5) return categorical; // too little signal for a meaningful centroid

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
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const blended = await Promise.race([
      (async () => {
        const vecs = await Promise.all(recent.map((r) => embed(r.title)));
        const dim = vecs[0]?.length ?? 0;
        // Dimension agreement is validated for EVERY vector, and the fallback is
        // all-or-nothing (the same doctrine as the cap): one short/empty vector
        // would otherwise poison the centroid with NaN — which would ship "N": null
        // on every pick AND silently delete N from the learning corpus — or hand
        // one candidate a free N=0.5 outlier from a degenerate cosine.
        if (!dim || vecs.some((v) => v.length !== dim)) return null;
        const centroid = new Array<number>(dim).fill(0);
        for (const v of vecs) for (let i = 0; i < dim; i++) centroid[i] += v[i] / vecs.length;
        // Parallel, not sequential: the cap bounds the fan-out, and serial awaits
        // multiplied the latency by the pool size for no benefit.
        const cvecs = await Promise.all(cands.map((c) => embed(c.title)));
        if (cvecs.some((v) => v.length !== dim)) return null;
        return cvecs.map(
          (v, i) => EMBED_BLEND * categorical[i] + (1 - EMBED_BLEND) * cosineDistance(v, centroid),
        );
      })(),
      new Promise<null>((resolve) => {
        budgetTimer = setTimeout(() => resolve(null), NOVELTY_BUDGET_MS);
      }),
    ]).finally(() => clearTimeout(budgetTimer));
    // ^ the timer is CLEARED on the fast path — an uncleared 4s timeout per request
    // held vitest workers open and added a measurable tail to graceful shutdown.
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
export function contextFit(vector: SituationVector, c: Candidate): number {
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

export function logShown(
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
): (string | null)[] {
  const tz = ownerTimezone(ownerId);
  const localDate = localDateInTZ(now.toISOString(), tz);
  const insert = sqlite.prepare(
    `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores, confidence)
     VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  return picks.map((p, i) => {
    if (!p) return null;
    const row = insert.get(
      ownerId,
      now.toISOString(),
      localDate,
      p.slot,
      p.kind,
      p.ref,
      JSON.stringify({ ...p.scores, ternary: p.ternary }),
      confidenceJson[i] ?? null,
    ) as { id: string };
    return row.id;
  });
}

export type Outcome = 'opened' | 'staged' | 'dismissed';
const OUTCOMES: readonly Outcome[] = ['opened', 'staged', 'dismissed'];
export function isOutcome(v: unknown): v is Outcome {
  return typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v);
}

/** Append-only discipline: a row's outcome is stamped AT MOST once — the guarded
 *  UPDATE makes a second stamp (or a foreign log id) a `changed:false` no-op. */
export function stampOutcome(ownerId: string, logId: string, outcome: Outcome, now: Date): { changed: boolean } {
  const res = sqlite
    .prepare(
      `UPDATE triality_log SET outcome = ?, outcome_at = ?
        WHERE id = ? AND owner_id = ? AND outcome = 'shown'`,
    )
    .run(outcome, now.toISOString(), logId, ownerId);
  return { changed: res.changes > 0 };
}

// ── The pipeline ──────────────────────────────────────────────────────────────

export async function trialityNext(ownerId: string, now: Date, opts: TrialityOpts = {}): Promise<TrialityResult> {
  const have = confirmedCompletionCount(ownerId, now);
  if (have < REFUSAL_FLOOR) return { refused: 'sparse_history', have, need: REFUSAL_FLOOR };

  const vector = buildSituationVector(ownerId, now);
  const gapMin = rawFreeGapMinutes(ownerId, now);

  // Stage 1 — hard capacity filter (§1: pipeline order is normative). Only a
  // KNOWN misfit drops: unknown gap or unknown estimate cannot honestly exclude.
  const all = collectCandidates(ownerId, now);
  const cands = all.filter(
    (c) => !(gapMin != null && c.estimateMin != null && c.estimateMin > gapMin - GAP_MARGIN_MIN),
  );
  if (cands.length === 0) {
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

  // Stage 2 — component scores.
  const history = completionHistory(ownerId, now);
  const { strengths: H, counts: histCounts } = habitStrengths(cands, history, now);
  const Q = sequenceFits(cands, history);
  const N = await noveltyScores(cands, H, ownerId, now, opts.embedFn);
  const F = cands.map((c) => contextFit(vector, c));
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
  const resolvedWeights = Object.fromEntries(SLOTS.map((s) => [s, weightsFor(ownerId, s)])) as Record<Slot, SlotWeights>;
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
