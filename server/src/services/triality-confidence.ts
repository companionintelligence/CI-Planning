import type { DecisionTelemetry, MarginBasis, ScoredPick } from './triality.js';
import type { SituationVector } from './triality-vector.js';

/**
 * Triality v2.2 — per-pick confidence (docs/triality-v2-design.md §4).
 *
 * Derived, deterministic, REPORTED — and never fed back into ranking. A score that both
 * ranks and rates itself is circular, so the guarantee here is structural rather than
 * intended:
 *
 *  - Every import in this file is `import type`, erased at compile time. This module has
 *    ZERO runtime imports, no database handle, no clock, no I/O.
 *  - services/triality.ts does not reference this file, in either direction of the type
 *    graph. The engine hands out `DecisionTelemetry` — raw numbers its stage-4 loop
 *    already computed — and never learns what is done with them.
 *  - `attachConfidence` is SYNCHRONOUS on purpose. A sync signature is itself a promise
 *    of no I/O: acquiring any would mean changing every call site, which is a review
 *    event rather than a quiet edit.
 *
 * v2.2 REPORTS ONLY. Nothing here suppresses a slot, reorders a pick, or changes a
 * weight — a `guess` still fills its slot. Gating is v2.5, and it is gated in turn on
 * the calibration tile showing these bands actually order outcomes (§5 of the spec:
 * an `inverted` verdict is a hard block).
 */

// ── Constants (§1) — named, justified, provisional by design ──────────────────

/** Bump on ANY change to the constants below or to a formula in this file.
 *  Stored on every row so the calibration tile can refuse to mix two models: the band
 *  constants are PROVISIONAL by design, and the first retune would otherwise silently
 *  destroy the very evidence that motivated it. */
export const CONFIDENCE_MODEL_VERSION = 1;

/** firm ⟺ value ≥ 0.4. Against a 12-dim denominator this is exactly "≥5 informative
 *  dims" (5/12 = 0.4167 clears, 4/12 = 0.3333 does not) and "≥4 matching completions"
 *  (4/8 = 0.5 clears, 3/8 = 0.375 does not). At |active| = 11 it is the SAME counts
 *  (5/11 = 0.4545, 4/11 = 0.3636), so the band means one thing in English whether or not
 *  the owner has configured work hours. 0.5 would demand ≥6 dims with zero headroom and
 *  make firm near-unreachable — a model that only ever says `guess` is not cautious, it
 *  is discrediting. PROVISIONAL: the calibration tile is what falsifies this. */
export const FIRM_AT = 0.4;

/** tentative ⟺ value ≥ 0.2, i.e. ≥3 informative dims and ≥2 matching completions.
 *  Placed ABOVE 2/12 = 0.1667 deliberately: `in_work_hours` has no data-bearing zero
 *  (triality-vector.ts) and `day_type` is non-zero for every date because resolveDayType
 *  always returns workday or weekend, so coverage has a hard floor of two dims that carry
 *  no owner-specific information at all. `tentative` is a positive claim, and "the vector
 *  learned nothing about you beyond what a calendar knows" is not one. PROVISIONAL. */
export const TENTATIVE_AT = 0.2;

/** Matching completions in the 90-day window that count as full evidence. MUST stay
 *  strictly below REFUSAL_FLOOR = 10: that floor is a GLOBAL, confirmation-gated count
 *  for the owner, this is PER-CANDIDATE-CLASS, and at 10+ an owner who has only just
 *  become rankable could not reach full evidence on any class — a component that is
 *  structurally unreachable would silently dictate every band. 8 over 90 days is one per
 *  11 days; 90/HALF_LIFE_DAYS ≈ 6.4, so 8 is roughly one completion per H half-life. */
export const EVIDENCE_FULL = 8;

/** Margin credit per ternary step of dot separation. `dot` is a small integer, so the
 *  scale is per-step rather than per-unit. One step can be inverted by a single dim
 *  flipping ⇒ half credit; two steps cannot ⇒ full credit. Flat, not slot-dependent: a
 *  number the owner reads must not mean one thing in Habitual and another in Contextual. */
export const MARGIN_PER_DOT_STEP = 0.5;

/** Ceiling on a score-tier margin, so the two tiers cannot overlap. A dot win is a win on
 *  the key the engine treats as PRIMARY; a score win means the ternary triple did not
 *  discriminate at all and the pick rode a tie-break. Letting those produce the same
 *  number would erase the distinction the lexicographic key exists to draw. */
export const MARGIN_TIER_CAP = 0.5;

/** Below this the winner's own S is effectively zero and the ratio is undefined; routed
 *  to `tie` rather than divided by. Defensive: on a dot tie S_w is the pool max, so
 *  S_w ≈ 0 implies S_r ≈ 0 and the tie branch was already the right answer. */
export const MARGIN_EPS = 1e-9;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConfidenceBand = 'firm' | 'tentative' | 'guess';
export type BindingComponent = 'coverage' | 'margin' | 'evidence';

/**
 * Key order is fixed and load-bearing: JSON.stringify follows declaration order, and a
 * byte-stable blob is what makes "same DB + same now ⇒ same row" checkable byte for byte
 * (the "COMPONENTS order in, COMPONENTS order out" discipline from triality-learning.ts).
 */
export interface PickConfidence {
  band: ConfidenceBand;
  /** min(coverage, margin, evidence) — the WEAKEST LINK, never an average. An average
   *  lets a decisive margin hide the fact that nothing was sensed; a minimum cannot. */
  value: number;
  coverage: number;
  margin: number;
  evidence: number;
  marginBasis: MarginBasis;
  /** Which component set the minimum — the one the hedging copy names. */
  binding: BindingComponent;
  counts: {
    dimsInformative: number;
    dimsActive: number;
    /** UNCAPPED — the ratio must not pretend 43 completions is the same as 8. */
    evidenceRows: number;
    eligible: number;
  };
  v: number;
}

/** Local copy of the engine's rounding, deliberately not imported: this module's zero
 *  runtime imports are the guarantee, and one shared 6-character helper is not worth
 *  spending it on. */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ── Coverage (§2) ─────────────────────────────────────────────────────────────

/**
 * How many of the dims the vector says it can sense right now are pulling in a
 * direction.
 *
 * Two things this number does NOT claim, both shipped as product copy rather than buried
 * here:
 *
 *  - It is not "how much was sensed". A sensed neutral and an unsensed hole are the same
 *    0 — `day_energy` 'flat', `free_gap` 15–45m, `momentum` 'no signal', an on-target
 *    `cat_deficit`. v1 §3 chose an encoding with no third state and `contextFit` drops a
 *    zero pair from its denominator either way, so the distinction does not exist for any
 *    consumer. Coverage inherits that honestly; it cannot manufacture a distinction the
 *    encoder threw away. The real fix is a `sensed` predicate beside `active` on
 *    DimEntry, which is a registry-contract widening and belongs to a later wave. The
 *    bias is DOWNWARD, which is the safe direction under a weakest link.
 *  - It is not "how much entered the score". `momentum` is active, sensed, and read by
 *    nothing in the engine (`vector.dims` has exactly two consumers: contextFit and
 *    capacityScore's energy factor). One dim of the twelve, disclosed in the tooltip.
 *
 * The denominator stays |meta.active| because the /next payload already ships `vector`
 * with `dims` and `meta.active` — the arithmetic IS the explanation, and a reader can
 * count the non-zero active dims and check this number themselves. Any restricted or
 * family-collapsed denominator would need a hidden map maintained in lockstep with
 * DIM_REGISTRY, with no compiler help: a net honesty loss and a two-site invariant
 * created on purpose.
 */
export function situationCoverage(
  vector: SituationVector,
): { value: number; informative: number; active: number } {
  const active = vector.meta.active;
  let informative = 0;
  for (const d of active) if ((vector.dims[d] ?? 0) !== 0) informative++;
  // 0/0 must never resolve to 1 ("everything sensible is sensed" when we can sense
  // nothing), and unguarded it would ship NaN through min() to the client. Unreachable
  // today — most registry entries have no `active` predicate — but a future registry
  // could make every dim conditional.
  return {
    value: active.length > 0 ? informative / active.length : 0,
    informative,
    active: active.length,
  };
}

// ── Margin (§3) ───────────────────────────────────────────────────────────────

/**
 * How decisively this pick won its slot, measured on the key the engine ACTUALLY
 * compares.
 *
 * The v2 design specified `(S_top − S_runner_up) / max(S_top, ε)`, which assumed the
 * engine ranks by slot score. It does not: stage 4 compares `[dot, S, ref]`
 * lexicographically, with S only as a tie-break. That formula is superseded because it
 * fails in the ordinary case — a winner at dot 3 / S 0.4 legitimately beats a runner-up
 * at dot 2 / S 0.9, and the subtraction goes NEGATIVE on a pick that was in fact
 * decisive. It also manufactures a clamped 1.0 out of a pool where nothing scored, since
 * a block template provably has H = 0 and Q = 0 and so can carry S = 0 exactly.
 *
 * The two tiers cannot overlap (score is capped below the smallest dot credit) because
 * they are different kinds of certainty: a dot win means the winner matched a ternary
 * pole the runner-up did not; a score win means the triple did not discriminate at all
 * and the pick rode a tie-break.
 *
 * Range [0, 1]. Never negative on any input, including a corrupt one — the reversed
 * comparisons are unreachable (the runner-up is by construction the best of the rest
 * under the same comparator) and fall through to `tie` rather than being subtracted.
 */
export function decisionMargin(d: DecisionTelemetry): { value: number; basis: MarginBasis } {
  // NO COMPARISON HAPPENED. Margin is a comparison quantity, and no data must never
  // render as a confident number — so this is 0, not 1. It is NOT the same state as a
  // tie, and `basis` carries that difference to the UI: "nothing else was eligible" is a
  // different sentence from "tied with another candidate". Reachable whenever the pool is
  // small, because `taken` consumes the earlier slots' winners.
  if (d.runnerUpDot === null || d.runnerUpScore === null) return { value: 0, basis: 'uncontested' };

  // A non-finite telemetry number is treated exactly like an unresolved one — the
  // conservative direction, and the reason no branch below can divide by garbage.
  if (
    !Number.isFinite(d.dot) || !Number.isFinite(d.score) ||
    !Number.isFinite(d.runnerUpDot) || !Number.isFinite(d.runnerUpScore)
  ) {
    return { value: 0, basis: 'tie' };
  }

  // A dot win is CATEGORICAL — a pole matched on the engine's primary key. min() is a
  // defensive clamp; the reachable separation is a handful of steps.
  if (d.dot > d.runnerUpDot) {
    return { value: Math.min(1, MARGIN_PER_DOT_STEP * (d.dot - d.runnerUpDot)), basis: 'dot' };
  }

  // Equal dot ⇒ S broke it, or nothing did. RELATIVE, not gap-over-a-constant: getWeights
  // validates each learned weight into [0.5·default, 2·default] but never checks their
  // SUM, so a restored or hand-edited triality_weights row can scale every S by up to 2×.
  // An absolute gap would scale with it and manufacture confidence; a ratio is immune.
  const gap = d.score - d.runnerUpScore;
  if (!(gap > MARGIN_EPS) || !(d.score > MARGIN_EPS)) return { value: 0, basis: 'tie' };
  return { value: MARGIN_TIER_CAP * Math.min(1, gap / d.score), basis: 'score' };
}

// ── Evidence (§4) ─────────────────────────────────────────────────────────────

/**
 * How much real completion history backs this candidate's H.
 *
 * Unweighted on purpose: H already prices recency (a 14-day half-life). Weighting twice
 * would collapse evidence for a habit done fifty times but paused a month — the lapse
 * belongs in the *score*, not in our *certainty about the score*. High evidence with low
 * H is a confident "this is not currently your habit", which is exactly what should let a
 * Novel pick be firm.
 */
export function evidenceScore(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return 0;
  return Math.min(1, rows / EVIDENCE_FULL);
}

export function bandFor(value: number): ConfidenceBand {
  if (value >= FIRM_AT) return 'firm';
  if (value >= TENTATIVE_AT) return 'tentative';
  return 'guess';
}

// ── Composition ───────────────────────────────────────────────────────────────

/**
 * Round-then-min-then-band is load-bearing. Components are rounded to 3dp FIRST; the min
 * of three 3dp values is itself 3dp, so there is no second rounding; and the band is a
 * pure function of the stored `value`. A reviewer with a calculator can verify any stored
 * row. Banding an unrounded min would let a printed 0.400 carry `tentative`, which is an
 * unverifiable payload.
 */
export function scoreConfidence(pick: ScoredPick, vector: SituationVector): PickConfidence {
  const cov = situationCoverage(vector);
  const mar = decisionMargin(pick.decision);

  const coverage = round3(cov.value);
  const margin = round3(mar.value);
  const evidence = round3(evidenceScore(pick.evidenceRows));
  const value = Math.min(coverage, margin, evidence);

  // Tie order is evidence → margin → coverage: most concrete sentence first. "You have
  // never done this" tells the owner more than "the vector is quiet today", and when both
  // are equally true the more actionable one should be the one the hedge names.
  const binding: BindingComponent =
    evidence === value ? 'evidence' : margin === value ? 'margin' : 'coverage';

  return {
    band: bandFor(value),
    value,
    coverage,
    margin,
    evidence,
    marginBasis: mar.basis,
    binding,
    counts: {
      dimsInformative: cov.informative,
      dimsActive: cov.active,
      evidenceRows: pick.evidenceRows,
      eligible: pick.decision.eligible,
    },
    v: CONFIDENCE_MODEL_VERSION,
  };
}

/**
 * Parallel to `picks`; null exactly where the pick is null.
 *
 * PURE: no database, no clock, no I/O, no mutation of its inputs. The picks it reads are
 * the ones already chosen — this runs after the engine has returned, and the engine never
 * sees the result.
 */
export function attachConfidence(
  picks: readonly (ScoredPick | null)[],
  vector: SituationVector,
): (PickConfidence | null)[] {
  return picks.map((p) => (p ? scoreConfidence(p, vector) : null));
}

export function serializeConfidence(c: PickConfidence | null): string | null {
  return c ? JSON.stringify(c) : null;
}

/**
 * NULL means "shown before v2.2" and must stay distinguishable forever — readers exclude
 * those rows rather than calling them a `guess`. A corrupt blob degrades the same way: an
 * unreadable row is not evidence, and it must never take the metrics tab down.
 */
export function parseConfidence(json: string | null): PickConfidence | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const c = parsed as PickConfidence;
    if (c.band !== 'firm' && c.band !== 'tentative' && c.band !== 'guess') return null;
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) return null;
    if (typeof c.v !== 'number') return null;
    return c;
  } catch {
    return null;
  }
}
