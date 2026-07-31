import { describe, it, expect } from 'vitest';
import {
  situationCoverage,
  decisionMargin,
  evidenceScore,
  bandFor,
  scoreConfidence,
  attachConfidence,
  serializeConfidence,
  parseConfidence,
  CONFIDENCE_MODEL_VERSION,
  FIRM_AT,
  TENTATIVE_AT,
  EVIDENCE_FULL,
  MARGIN_PER_DOT_STEP,
  MARGIN_TIER_CAP,
  MARGIN_EPS,
  type ConfidenceBand,
} from '../src/services/triality-confidence.js';
import type { DecisionTelemetry, ScoredPick } from '../src/services/triality.js';
import type { DimName, SituationVector, Ternary } from '../src/services/triality-vector.js';

/**
 * Triality v2.2 — confidence arithmetic (spec §9, cases C1–C16).
 *
 * PURE by construction, and that is itself part of what is under test: the only runtime
 * import in this file is the module itself. Every situation vector and every piece of
 * decision telemetry is hand-built, so no database is opened, no server starts, no clock
 * is read and nothing here can pass or fail because of a seeded row somewhere else.
 * `../src/services/triality.js` and `triality-vector.js` are imported for TYPES ONLY —
 * pulling either in at runtime would drag the database in behind it.
 *
 * Every expectation is derived from the exported constants rather than transcribed from
 * them, so a retune of FIRM_AT / TENTATIVE_AT / EVIDENCE_FULL moves these tests with it
 * instead of turning them red. The two exceptions are labelled where they occur: they pin
 * the English the constants are documented to mean, which is copy the owner reads, and it
 * SHOULD have to be re-argued when the constant moves.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

/**
 * Every dim at an honest zero. Written as an exhaustive object literal rather than a loop
 * over DIM_REGISTRY for two reasons: it keeps this file free of any runtime import, and
 * `Record<DimName, Ternary>` turns a newly registered dim into a COMPILE error here rather
 * than a test that quietly keeps passing against a stale denominator.
 */
const ZERO_DIMS: Record<DimName, Ternary> = {
  in_work_hours: 0,
  day_energy: 0,
  free_gap: 0,
  day_type: 0,
  momentum: 0,
  memory_context: 0,
  motivation_balance: 0,
  cat_deficit_health: 0,
  cat_deficit_career: 0,
  cat_deficit_relationships: 0,
  cat_deficit_growth: 0,
  cat_deficit_leisure: 0,
  cat_deficit_finance: 0,
};

/**
 * |meta.active| is 12 when the owner has work hours configured and 11 when they do not
 * (`in_work_hours` is the conditional one), and NEVER 13: `memory_context` reports
 * `active: () => false`, the v2.1 truthfulness fix. Both denominators are exercised
 * because §1 claims the bands mean the same dim COUNT under either — see C13.
 */
const ACTIVE_12: readonly DimName[] = [
  'in_work_hours',
  'day_energy',
  'free_gap',
  'day_type',
  'momentum',
  'motivation_balance',
  'cat_deficit_health',
  'cat_deficit_career',
  'cat_deficit_relationships',
  'cat_deficit_growth',
  'cat_deficit_leisure',
  'cat_deficit_finance',
];
const ACTIVE_11: readonly DimName[] = ACTIVE_12.filter((d) => d !== 'in_work_hours');

/** `informative` of `active`'s dims lean +1; the rest stay at an honest zero. */
function vectorOf(informative: number, active: readonly DimName[] = ACTIVE_12): SituationVector {
  const dims: Record<DimName, Ternary> = { ...ZERO_DIMS };
  for (let i = 0; i < informative; i++) dims[active[i]] = 1;
  return { dims, meta: { active: [...active] } };
}

/** Defaults to an exact tie — dot equal, S equal — so every test must OPT IN to a win. */
const telemetry = (over: Partial<DecisionTelemetry> = {}): DecisionTelemetry => ({
  eligible: 2,
  dot: 0,
  score: 0.5,
  runnerUpDot: 0,
  runnerUpScore: 0.5,
  ...over,
});

/** A dot separation of two ternary steps: the smallest gap MARGIN_PER_DOT_STEP saturates. */
const DECISIVE_DOT_STEPS = 2;

/**
 * `scoreConfidence` reads exactly two things off a pick — `decision` and `evidenceRows`.
 * `scores` and `ternary` are filled with values that appear in no expectation anywhere in
 * this file, so an edit that starts reading them produces an obviously wrong number rather
 * than a plausible one.
 */
function pick(o: { decision?: Partial<DecisionTelemetry>; evidenceRows?: number } = {}): ScoredPick {
  return {
    kind: 'task',
    ref: 'cand-1',
    title: 'fixture candidate',
    estimateMin: 20,
    direction: null,
    categories: [],
    motivation: null,
    slot: 'habitual',
    scores: { F: 0.777, H: 0.777, Q: 0.777, N: 0.777, C: 0.777, total: 0.777 },
    ternary: [1, 1, 1],
    decision: telemetry(o.decision),
    evidenceRows: o.evidenceRows ?? 0,
  };
}

/** Mirrors the module's private rounding so expectations can be DERIVED from the
 *  constants rather than transcribed at 3dp by hand. */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** A stored component must be a 3dp value — that is what makes a row hand-checkable. */
const is3dp = (v: number) => v === round3(v);

/** Smallest informative-dim count whose 3dp coverage clears `threshold` at `active` dims. */
function minDims(threshold: number, active: number): number {
  for (let n = 0; n <= active; n++) if (round3(n / active) >= threshold) return n;
  return active + 1;
}

/** Smallest matching-completion count whose evidence clears `threshold`. */
function minRows(threshold: number): number {
  for (let n = 0; n <= EVIDENCE_FULL; n++) if (round3(evidenceScore(n)) >= threshold) return n;
  return EVIDENCE_FULL + 1;
}

// ── margin (§3) ───────────────────────────────────────────────────────────────

describe('constants that a second site depends on', () => {
  it('EVIDENCE_FULL is 8 — and client/src/components/TrialityBanner.tsx holds a copy', () => {
    // ⚠️ TWO-SITE CONSTANT, the PENDING_MS situation again. The banner's expansion prints
    // "evidence {n} of {EVIDENCE_FULL}" from a client-local literal, because the server
    // ships the ratio and the raw count but not the denominator. Nothing on the client
    // re-derives a band from it, so a drift costs a wrong printed sentence rather than a
    // wrong badge — but "evidence 12 of 8" is arithmetically impossible prose, and this
    // repo's rule is that shipped copy must be true of what the code computes.
    //
    // Every other test here reads the constant rather than the number, so a retune would
    // otherwise sail through both suites green. This is the one place the value itself is
    // pinned: if you change it, change client/src/components/TrialityBanner.tsx and its
    // test in the same commit, and bump CONFIDENCE_MODEL_VERSION.
    expect(EVIDENCE_FULL).toBe(8);
  });
});

describe('margin — measured on the key the engine actually compares', () => {
  // C1 — the doctrine case.
  it('margin: uncontested is 0, not 1', () => {
    // No comparison happened, and margin IS a comparison quantity. The tempting answer is
    // 1.0 ("it won by a mile") and it is exactly backwards: nothing was weighed, so there
    // is nothing to be confident about. Reachable in ordinary use — `taken` consumes the
    // earlier slots' winners, so a small pool empties out.
    expect(decisionMargin(telemetry({ runnerUpDot: null, runnerUpScore: null }))).toEqual({
      value: 0,
      basis: 'uncontested',
    });

    // Either half missing is the same state; neither is allowed to fall through to a
    // branch that reads the other as 0 and manufactures a gap.
    expect(decisionMargin(telemetry({ dot: 3, runnerUpDot: null }))).toEqual({ value: 0, basis: 'uncontested' });
    expect(decisionMargin(telemetry({ score: 0.9, runnerUpScore: null }))).toEqual({ value: 0, basis: 'uncontested' });

    // `uncontested` is NOT `tie`: "nothing else was eligible" and "tied with another
    // candidate" are different sentences, and the basis is what lets the UI tell them
    // apart even though both price to 0.
    expect(decisionMargin(telemetry({ runnerUpDot: null })).basis).not.toBe('tie');
  });

  // C2
  it('margin: dot win scales per ternary step', () => {
    // dot is a small integer, so credit is per STEP. One step can be inverted by a single
    // dim flipping ⇒ half credit; two cannot ⇒ full credit; beyond that the clamp holds.
    expect(decisionMargin(telemetry({ dot: 1, runnerUpDot: 0 }))).toEqual({
      value: MARGIN_PER_DOT_STEP,
      basis: 'dot',
    });
    expect(decisionMargin(telemetry({ dot: 2, runnerUpDot: 0 }))).toEqual({ value: 1, basis: 'dot' });
    expect(decisionMargin(telemetry({ dot: 3, runnerUpDot: -2 }))).toEqual({ value: 1, basis: 'dot' });

    // Negative dots are ordinary (post-veto habitual/novel reach −2); only the GAP counts.
    expect(decisionMargin(telemetry({ dot: -1, runnerUpDot: -2 }))).toEqual({
      value: MARGIN_PER_DOT_STEP,
      basis: 'dot',
    });

    // The dot branch is decided before S is looked at, exactly as the engine's key is: a
    // winner with the WORSE tie-break score still won on the primary level.
    expect(decisionMargin(telemetry({ dot: 2, score: 0.01, runnerUpDot: 0, runnerUpScore: 0.99 }))).toEqual({
      value: 1,
      basis: 'dot',
    });
  });

  // C3
  it('margin: score tier never outranks a dot tier', () => {
    // The most decisive score win possible: the runner-up scored nothing at all.
    const best = decisionMargin(telemetry({ dot: 0, score: 1, runnerUpDot: 0, runnerUpScore: 0 }));
    expect(best).toEqual({ value: MARGIN_TIER_CAP, basis: 'score' });

    // A score win means the ternary triple did not discriminate AT ALL and the pick rode a
    // tie-break. It must never price above the cheapest real win on the primary key, or
    // the distinction the lexicographic key exists to draw is erased.
    for (let steps = 1; steps <= 5; steps++) {
      const dotWin = decisionMargin(telemetry({ dot: steps, runnerUpDot: 0 }));
      expect(dotWin.basis).toBe('dot');
      expect(best.value).toBeLessThanOrEqual(dotWin.value);
    }

    // Relative, not absolute: doubling every S leaves the number untouched. getWeights
    // bounds each weight but never their SUM, so a restored triality_weights row can scale
    // the whole of S — an absolute gap would scale with it and manufacture confidence.
    const half = decisionMargin(telemetry({ score: 1, runnerUpScore: 0.5 }));
    const doubled = decisionMargin(telemetry({ score: 2, runnerUpScore: 1 }));
    expect(doubled).toEqual(half);
    expect(half.value).toBe(MARGIN_TIER_CAP * 0.5);
  });

  // C4
  it('margin: exact S tie is a coin flip', () => {
    // Equal dot and bit-identical S means `ref` order decided the slot. That is a coin
    // flip, and it is REACHABLE, not theoretical: a pool with no value spread ternarizes
    // to all zeros, so every dot is 0 and every S equal.
    expect(decisionMargin(telemetry({ dot: 0, score: 0.5, runnerUpDot: 0, runnerUpScore: 0.5 }))).toEqual({
      value: 0,
      basis: 'tie',
    });
    expect(decisionMargin(telemetry({ dot: -2, score: 0, runnerUpDot: -2, runnerUpScore: 0 }))).toEqual({
      value: 0,
      basis: 'tie',
    });
  });

  // C5
  it('margin: sub-epsilon and zero-S degrade to tie', () => {
    // A gap that only exists in the last bits of a double is not a decision.
    const subEpsilon = decisionMargin(telemetry({ score: 0.5 + 1e-16, runnerUpScore: 0.5 }));
    expect(subEpsilon).toEqual({ value: 0, basis: 'tie' });
    expect(MARGIN_EPS).toBeGreaterThan(0);

    // The winner's own S is the divisor. At S_w = 0 the ratio is undefined, so the guard
    // must route to `tie` BEFORE dividing — 0/0 would ship NaN and a positive gap over 0
    // would ship Infinity, either of which then travels through min() to the client.
    const zeroOverZero = decisionMargin(telemetry({ score: 0, runnerUpScore: 0 }));
    expect(zeroOverZero).toEqual({ value: 0, basis: 'tie' });

    const positiveGapOverZero = decisionMargin(telemetry({ score: 0, runnerUpScore: -1 }));
    expect(positiveGapOverZero).toEqual({ value: 0, basis: 'tie' });
    expect(Number.isFinite(positiveGapOverZero.value)).toBe(true);
  });

  // C6 — the design-as-written regression guard.
  it('margin is never negative on any input', () => {
    // The v2 doc specified `(S_top − S_runner_up) / max(S_top, ε)`. That formula goes
    // NEGATIVE in the ORDINARY case — a winner at dot 3 / S 0.4 legitimately beats a
    // runner-up at dot 2 / S 0.9 — and a negative component would sail through min() and
    // out to the owner as a confidence below zero. This grid is the guard against anyone
    // reinstating it: it walks d1 ≥ d2 AND d1 < d2, S1 ≥ S2 AND S1 < S2, and the
    // non-finite corruptions, and demands [0, 1] every single time.

    // The exact shape that killed the doc formula, named first so a regression fails HERE
    // with the doctrine in the message rather than somewhere in the grid: a winner that is
    // decisive on the primary key while scoring LOWER on the tie-break. The superseded
    // formula returns (0.4 − 0.9)/0.4 = −1.25 for this pick.
    const decisiveButLowerScored = decisionMargin(
      telemetry({ dot: 1, score: 0.4, runnerUpDot: 0, runnerUpScore: 0.9 }),
    );
    expect(decisiveButLowerScored.value).toBeGreaterThanOrEqual(0);
    expect(decisiveButLowerScored).toEqual({ value: MARGIN_PER_DOT_STEP, basis: 'dot' });

    const DOTS = [-2, -1, 0, 1, 2, 3, NaN, Infinity, -Infinity];
    const SCORES = [0, 1e-16, 0.001, 0.4, 0.9, 1, NaN, Infinity, -Infinity];
    const BASES = ['uncontested', 'dot', 'score', 'tie'];

    let cases = 0;
    let sawInverted = false;
    for (const dot of DOTS) {
      for (const runnerUpDot of DOTS) {
        for (const score of SCORES) {
          for (const runnerUpScore of SCORES) {
            const d = telemetry({ dot, score, runnerUpDot, runnerUpScore });
            const { value, basis } = decisionMargin(d);
            cases++;
            if (dot < runnerUpDot || score < runnerUpScore) sawInverted = true;

            expect(BASES).toContain(basis);
            // The single load-bearing assertion. Stated as three separate expectations so
            // a failure names which one broke rather than just "not in range".
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);

            // The tiers cannot overlap, on any input including a corrupt one.
            if (basis === 'dot') expect(value).toBeGreaterThanOrEqual(MARGIN_TIER_CAP);
            if (basis === 'score') expect(value).toBeLessThanOrEqual(MARGIN_TIER_CAP);
            if (basis === 'uncontested' || basis === 'tie') expect(value).toBe(0);
          }
        }
      }
    }
    // The grid is only a guard if it actually contained the reversed orderings.
    expect(sawInverted).toBe(true);
    expect(cases).toBe(DOTS.length ** 2 * SCORES.length ** 2);

    // A missing runner-up is the other shape of "corrupt or absent", and it is checked
    // first precisely so no later branch can read the surviving half as a zero.
    for (const dot of DOTS) {
      for (const score of SCORES) {
        expect(decisionMargin(telemetry({ dot, score, runnerUpDot: null, runnerUpScore: null }))).toEqual({
          value: 0,
          basis: 'uncontested',
        });
      }
    }
  });
});

// ── coverage (§2) ─────────────────────────────────────────────────────────────

describe('coverage — how many active dims are pulling in a direction', () => {
  // C7
  it('coverage arithmetic on a hand-built vector', () => {
    // The ratio is exact: a reader with the /next payload can count the non-zero active
    // dims and reproduce it. That is the whole reason the denominator stays |meta.active|.
    expect(situationCoverage(vectorOf(2))).toEqual({ value: 2 / 12, informative: 2, active: 12 });
    expect(situationCoverage(vectorOf(5))).toEqual({ value: 5 / 12, informative: 5, active: 12 });
    expect(situationCoverage(vectorOf(12))).toEqual({ value: 1, informative: 12, active: 12 });
    expect(situationCoverage(vectorOf(3, ACTIVE_11))).toEqual({ value: 3 / 11, informative: 3, active: 11 });

    // What the owner actually sees is the 3dp form.
    expect(scoreConfidence(pick(), vectorOf(2)).coverage).toBe(0.167);
    expect(scoreConfidence(pick(), vectorOf(5)).coverage).toBe(0.417);
    expect(scoreConfidence(pick(), vectorOf(12)).coverage).toBe(1);
    expect(scoreConfidence(pick(), vectorOf(3, ACTIVE_11)).coverage).toBe(0.273);

    // A −1 leans just as hard as a +1 — "informative" is non-zero, not positive.
    const leaning = vectorOf(0);
    leaning.dims.day_energy = -1;
    leaning.dims.free_gap = -1;
    expect(situationCoverage(leaning)).toEqual({ value: 2 / 12, informative: 2, active: 12 });

    // meta.active gates BOTH halves of the fraction. `memory_context` is never active, so
    // even a (currently impossible) non-zero reading on it must not enter the numerator —
    // the v2.1 truthfulness fix has to hold here or coverage silently inherits the lie.
    const inactiveDim = vectorOf(2);
    inactiveDim.dims.memory_context = 1;
    expect(situationCoverage(inactiveDim)).toEqual({ value: 2 / 12, informative: 2, active: 12 });
  });

  // C8
  it('coverage: empty active set is 0, not 1 and not NaN', () => {
    // 0/0 must never resolve to 1 — "everything sensible is sensed" said at the moment we
    // can sense nothing is the most dishonest number this module could print. Unguarded it
    // is NaN, which travels through min(), through JSON (as null), and out to the client.
    const empty = situationCoverage(vectorOf(0, []));
    expect(empty).toEqual({ value: 0, informative: 0, active: 0 });
    expect(Number.isNaN(empty.value)).toBe(false);
    expect(empty.value).not.toBe(1);

    // End to end: a decisive, fully evidenced pick in a vector that senses nothing is a
    // guess, and the hedge names coverage.
    const c = scoreConfidence(
      pick({ decision: { dot: DECISIVE_DOT_STEPS, runnerUpDot: 0 }, evidenceRows: EVIDENCE_FULL }),
      vectorOf(0, []),
    );
    expect(c).toMatchObject({ value: 0, band: 'guess', binding: 'coverage' });
    expect(c.counts).toMatchObject({ dimsInformative: 0, dimsActive: 0 });
  });
});

// ── evidence (§4) ─────────────────────────────────────────────────────────────

describe('evidence — completion rows behind H', () => {
  // C9
  it('evidence floor and clamp', () => {
    expect(evidenceScore(0)).toBe(0);
    expect(evidenceScore(1)).toBe(1 / EVIDENCE_FULL);
    expect(evidenceScore(2)).toBe(2 / EVIDENCE_FULL);
    expect(evidenceScore(EVIDENCE_FULL / 2)).toBe(0.5);

    // The ceiling sits exactly ON the constant, and the row below it is genuinely below.
    expect(evidenceScore(EVIDENCE_FULL)).toBe(1);
    expect(evidenceScore(EVIDENCE_FULL - 1)).toBeLessThan(1);
    expect(evidenceScore(200)).toBe(1);
    expect(evidenceScore(EVIDENCE_FULL * 25)).toBe(1);

    // Clamped in the score, UNCAPPED in the count: the ratio must not pretend that 43
    // completions is the same as 8, so the raw number still ships beside it.
    expect(scoreConfidence(pick({ evidenceRows: 43 }), vectorOf(12)).counts.evidenceRows).toBe(43);

    // Garbage degrades downward, never into a negative or a NaN.
    expect(evidenceScore(-1)).toBe(0);
    expect(evidenceScore(NaN)).toBe(0);
    expect(evidenceScore(Infinity)).toBe(0);

    // The English of the band constants, on the evidence axis: firm needs ≥4 matching
    // completions and tentative ≥2 (§1). Derived, so a retune moves them.
    expect(minRows(FIRM_AT)).toBe(EVIDENCE_FULL / 2);
    expect(bandFor(evidenceScore(minRows(FIRM_AT)))).toBe('firm');
    expect(bandFor(evidenceScore(minRows(FIRM_AT) - 1))).not.toBe('firm');
    expect(bandFor(evidenceScore(minRows(TENTATIVE_AT)))).toBe('tentative');
    expect(bandFor(evidenceScore(minRows(TENTATIVE_AT) - 1))).toBe('guess');
  });
});

// ── the weakest link (§1) ─────────────────────────────────────────────────────

describe('weakest link — min, never an average', () => {
  // C10 — the v2 design §11.2 named requirement.
  it('weakest link: a decisive margin with near-zero coverage must NOT read firm', () => {
    // This is the case the whole scoring shape exists for. One informative dim of twelve,
    // an unarguable dot win and full completion history. An AVERAGE would report
    // (0.083 + 1 + 1) / 3 = 0.694 and badge this `firm` — a confident claim resting on a
    // situation the vector could barely read. The minimum cannot do that: the weakest
    // component is the honest one, and it is the one the owner is told about.
    const c = scoreConfidence(
      pick({ decision: { dot: DECISIVE_DOT_STEPS, runnerUpDot: 0 }, evidenceRows: EVIDENCE_FULL }),
      vectorOf(1),
    );

    expect(c.coverage).toBe(0.083);
    expect(c.margin).toBe(1);
    expect(c.evidence).toBe(1);
    expect(c.value).toBe(0.083);
    expect(c.band).toBe('guess');
    expect(c.binding).toBe('coverage');

    // Not an average, stated as an assertion rather than a comment.
    expect(c.value).not.toBe(round3((c.coverage + c.margin + c.evidence) / 3));
    expect(c.value).toBe(Math.min(c.coverage, c.margin, c.evidence));

    // The ratio never travels without its denominator.
    expect(c.counts).toEqual({
      dimsInformative: 1,
      dimsActive: ACTIVE_12.length,
      evidenceRows: EVIDENCE_FULL,
      eligible: 2,
    });
  });

  // C11
  it('weakest link: zero evidence pins to guess', () => {
    // The mirror image of C10, and the one that makes every block-template pick a
    // permanent guess: `historyMatches` excludes templates by construction, so
    // evidenceRows is 0 forever and no amount of coverage or margin can lift it.
    const c = scoreConfidence(
      pick({ decision: { dot: DECISIVE_DOT_STEPS, runnerUpDot: 0 }, evidenceRows: 0 }),
      vectorOf(12),
    );
    expect(c.coverage).toBe(1);
    expect(c.margin).toBe(1);
    expect(c.evidence).toBe(0);
    expect(c.value).toBe(0);
    expect(c.band).toBe('guess');
    expect(c.binding).toBe('evidence');
  });

  // C12
  it('band boundaries are inclusive at the constant', () => {
    // Inclusive AT the threshold, which is what "≥5 informative dims" means in §1; a
    // strict > would move every documented count by one and silently.
    expect(bandFor(FIRM_AT)).toBe('firm');
    expect(bandFor(FIRM_AT - 0.001)).toBe('tentative');
    expect(bandFor(TENTATIVE_AT)).toBe('tentative');
    expect(bandFor(TENTATIVE_AT - 0.001)).toBe('guess');
    expect(bandFor(0)).toBe('guess');
    expect(bandFor(1)).toBe('firm');

    // The ordering the bands depend on, asserted rather than assumed.
    expect(FIRM_AT).toBeGreaterThan(TENTATIVE_AT);
    expect(TENTATIVE_AT).toBeGreaterThan(0);
  });

  // C13
  it('bands mean the same dim COUNT at 11 and 12 active', () => {
    // The point of FIRM_AT = 0.4: the band means one thing in English whether or not the
    // owner has configured work hours. If a retune ever splits these, the tooltip copy
    // ("5 of 12 signals…") stops being true at one of the two denominators.
    expect(minDims(FIRM_AT, ACTIVE_12.length)).toBe(minDims(FIRM_AT, ACTIVE_11.length));
    expect(minDims(TENTATIVE_AT, ACTIVE_12.length)).toBe(minDims(TENTATIVE_AT, ACTIVE_11.length));

    // Pins the documented English itself (§1: "≥5 informative dims", "≥3"). Deliberately a
    // literal: this is copy the owner reads, and a retune that moves it should have to
    // re-argue the sentence and bump CONFIDENCE_MODEL_VERSION, not slide past a green run.
    expect(minDims(FIRM_AT, ACTIVE_12.length)).toBe(5);
    expect(minDims(TENTATIVE_AT, ACTIVE_12.length)).toBe(3);

    // End to end at both denominators, with margin and evidence saturated so coverage is
    // provably the component doing the banding.
    const firmDims = minDims(FIRM_AT, ACTIVE_12.length);
    const tentativeDims = minDims(TENTATIVE_AT, ACTIVE_12.length);
    const saturated = pick({ decision: { dot: DECISIVE_DOT_STEPS, runnerUpDot: 0 }, evidenceRows: EVIDENCE_FULL });

    for (const active of [ACTIVE_12, ACTIVE_11]) {
      const band = (n: number): ConfidenceBand => scoreConfidence(saturated, vectorOf(n, active)).band;
      expect(band(firmDims)).toBe('firm');
      expect(band(firmDims - 1)).toBe('tentative');
      expect(band(tentativeDims)).toBe('tentative');
      expect(band(tentativeDims - 1)).toBe('guess');
    }
  });

  // C14
  it('binding tie order is evidence → margin → coverage', () => {
    // Most concrete sentence first. "You have never done this" tells the owner more than
    // "the vector is quiet today", so when both are equally true the hedge names the more
    // actionable one.
    const halfCoverage = ACTIVE_12.length / 2;                               // 6/12 = 0.5
    const capMargin = { dot: 0, score: 1, runnerUpDot: 0, runnerUpScore: 0 }; // MARGIN_TIER_CAP
    const halfEvidence = EVIDENCE_FULL / 2;                                   // 4/8 = 0.5

    const allThree = scoreConfidence(
      pick({ decision: capMargin, evidenceRows: halfEvidence }),
      vectorOf(halfCoverage),
    );
    expect([allThree.coverage, allThree.margin, allThree.evidence]).toEqual([0.5, 0.5, 0.5]);
    expect(allThree.binding).toBe('evidence');

    // margin ties coverage, evidence is higher → margin.
    const marginAndCoverage = scoreConfidence(
      pick({ decision: capMargin, evidenceRows: EVIDENCE_FULL }),
      vectorOf(halfCoverage),
    );
    expect(marginAndCoverage.value).toBe(0.5);
    expect(marginAndCoverage.binding).toBe('margin');

    // evidence ties coverage, margin is higher → evidence still wins the tie.
    const evidenceAndCoverage = scoreConfidence(
      pick({ decision: { dot: DECISIVE_DOT_STEPS, runnerUpDot: 0 }, evidenceRows: halfEvidence }),
      vectorOf(halfCoverage),
    );
    expect(evidenceAndCoverage.value).toBe(0.5);
    expect(evidenceAndCoverage.binding).toBe('evidence');

    // Coverage is named only when it alone is the weakest — the tie order never reaches it.
    const coverageAlone = scoreConfidence(
      pick({ decision: capMargin, evidenceRows: EVIDENCE_FULL }),
      vectorOf(minDims(TENTATIVE_AT, ACTIVE_12.length)),
    );
    expect(coverageAlone.value).toBe(0.25);
    expect(coverageAlone.binding).toBe('coverage');
  });

  // C15
  it('round-then-min: value === min(printed components)', () => {
    // Round-then-min-then-band is load-bearing. Components are rounded to 3dp FIRST, so
    // the min of three 3dp values is itself 3dp and needs no second rounding, and the band
    // is a pure function of the number that was stored. Banding an unrounded min would let
    // a printed 0.400 carry `tentative` — a payload nobody could verify with a calculator.
    const MARGINS: Partial<DecisionTelemetry>[] = [
      { runnerUpDot: null, runnerUpScore: null },                  // uncontested → 0
      { dot: 1, runnerUpDot: 0 },                                  // dot, one step
      { dot: DECISIVE_DOT_STEPS, runnerUpDot: 0 },                 // dot, saturated
      { dot: 4, runnerUpDot: -1 },                                 // dot, clamped
      { dot: 0, score: 1, runnerUpDot: 0, runnerUpScore: 0 },      // score, at the cap
      { dot: 0, score: 1, runnerUpDot: 0, runnerUpScore: 0.5 },    // score, half the cap
      { dot: 0, score: 0.9, runnerUpDot: 0, runnerUpScore: 0.887 },// score, a thin win
      { dot: 0, score: 0.5, runnerUpDot: 0, runnerUpScore: 0.5 },  // tie → 0
      { dot: 0, score: 0.5 + 1e-16, runnerUpDot: 0, runnerUpScore: 0.5 }, // sub-ε → 0
    ];
    const ROWS = [0, 1, 2, 3, EVIDENCE_FULL / 2, EVIDENCE_FULL - 1, EVIDENCE_FULL, EVIDENCE_FULL + 1, 200];

    let checked = 0;
    for (const active of [ACTIVE_12, ACTIVE_11]) {
      for (let informative = 0; informative <= active.length; informative++) {
        for (const decision of MARGINS) {
          for (const evidenceRows of ROWS) {
            const c = scoreConfidence(pick({ decision, evidenceRows }), vectorOf(informative, active));
            checked++;

            expect(is3dp(c.coverage)).toBe(true);
            expect(is3dp(c.margin)).toBe(true);
            expect(is3dp(c.evidence)).toBe(true);
            // The min of three 3dp values is 3dp — no second rounding anywhere.
            expect(is3dp(c.value)).toBe(true);

            expect(c.value).toBe(Math.min(c.coverage, c.margin, c.evidence));
            expect(c.band).toBe(bandFor(c.value));
            // The named component always genuinely holds the minimum.
            expect(c[c.binding]).toBe(c.value);

            expect(c.value).toBeGreaterThanOrEqual(0);
            expect(c.value).toBeLessThanOrEqual(1);
            expect(c.v).toBe(CONFIDENCE_MODEL_VERSION);
          }
        }
      }
    }
    expect(checked).toBe((ACTIVE_12.length + 1 + ACTIVE_11.length + 1) * MARGINS.length * ROWS.length);
  });
});

// ── storage shape (§6) ────────────────────────────────────────────────────────

describe('serialization', () => {
  // C16
  it('serialize/parse round-trips byte-stably', () => {
    const c = scoreConfidence(
      pick({ decision: { dot: 1, runnerUpDot: 0, eligible: 14 }, evidenceRows: 2 }),
      vectorOf(3),
    );
    const json = serializeConfidence(c);
    expect(json).not.toBeNull();

    // Key order is fixed and load-bearing: JSON.stringify follows declaration order, and a
    // byte-stable blob is what makes "same DB + same now ⇒ the same row" checkable byte
    // for byte rather than field by field.
    expect(Object.keys(JSON.parse(json!))).toEqual([
      'band', 'value', 'coverage', 'margin', 'evidence', 'marginBasis', 'binding', 'counts', 'v',
    ]);
    expect(Object.keys(JSON.parse(json!).counts)).toEqual([
      'dimsInformative', 'dimsActive', 'evidenceRows', 'eligible',
    ]);

    const parsed = parseConfidence(json);
    expect(parsed).toEqual(c);
    expect(serializeConfidence(parsed)).toBe(json);
    expect(serializeConfidence(c)).toBe(json);
    expect(parsed!.v).toBe(CONFIDENCE_MODEL_VERSION);

    // A stored row is self-verifying: both invariants a reader is allowed to assume.
    expect(parsed!.value).toBe(Math.min(parsed!.coverage, parsed!.margin, parsed!.evidence));
    expect(parsed!.band).toBe(bandFor(parsed!.value));
  });

  it('null means pre-v2.2 and survives the round trip as null', () => {
    // NULL is "shown before confidence scoring" and must stay distinguishable FOREVER —
    // readers exclude those rows rather than calling them a `guess`, because pre-v2.2 rows
    // skew toward the feature's earliest period and coercing them would bias the very
    // comparison the calibration tile exists to make.
    expect(serializeConfidence(null)).toBeNull();
    expect(parseConfidence(null)).toBeNull();
    expect(parseConfidence('')).toBeNull();
  });

  it('a corrupt or off-enum blob degrades to null without throwing', () => {
    // An unreadable row is not evidence, and it must never take the metrics tab down.
    for (const bad of [
      '{not json',
      '{"band":"firm",',
      'null',
      '"firm"',
      '42',
      '[]',
      '{"band":"solid","value":0.5,"v":1}',      // off-enum band — never buckets
      '{"band":"firm","value":"0.5","v":1}',     // value not a number
      '{"band":"firm","value":null,"v":1}',
      '{"band":"firm","v":1}',                   // value missing
      '{"band":"firm","value":0.5}',             // version missing: cohort unknowable
    ]) {
      expect(() => parseConfidence(bad)).not.toThrow();
      expect(parseConfidence(bad)).toBeNull();
    }

    // A non-finite value is unreadable too — it would print as `null` through JSON and
    // then compare its way into a band.
    expect(parseConfidence('{"band":"firm","value":1e999,"v":1}')).toBeNull();
  });
});

// ── the attach seam (§5) ──────────────────────────────────────────────────────

describe('attachConfidence', () => {
  it('is parallel to picks and null exactly where the pick is null', () => {
    // An honest empty slot has no confidence — not a zero-confidence blob, which would
    // read as "we looked and were unsure" rather than "there was nothing to show".
    const vector = vectorOf(5);
    const out = attachConfidence([pick({ evidenceRows: EVIDENCE_FULL }), null, pick()], vector);

    expect(out).toHaveLength(3);
    expect(out[1]).toBeNull();
    expect(out[0]).not.toBeNull();
    expect(out[2]).not.toBeNull();
    expect(out.map((c) => c === null)).toEqual([false, true, false]);
  });

  it('shares one vector across all three picks, so coverage is a banner-level fact', () => {
    // All three picks are scored against the SAME situation vector, so coverage is
    // identical across them by construction. That is why the coverage sentence renders
    // ONCE at banner level: printed three times it would read as a coincidence rather than
    // the shared fact it is. It is also why coverage can never explain why one pick is
    // firmer than another, and why the calibration floor has to account for the
    // correlation it creates.
    const vector = vectorOf(4);
    const out = attachConfidence(
      [pick({ evidenceRows: EVIDENCE_FULL }), pick({ evidenceRows: 1 }), pick()],
      vector,
    );
    const coverages = out.map((c) => c!.coverage);
    expect(new Set(coverages).size).toBe(1);
    expect(coverages[0]).toBe(round3(4 / ACTIVE_12.length));
  });
});
