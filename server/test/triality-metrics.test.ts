import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { trialityMetrics, type TrialityCalibration, type ConfidenceBandStats } from '../src/services/triality-metrics.js';
import { calibrateTriality, OUTCOME_FLOOR, PENDING_MS } from '../src/services/triality-learning.js';
import {
  CONFIDENCE_MODEL_VERSION, EVIDENCE_FULL, FIRM_AT, TENTATIVE_AT, bandFor, parseConfidence,
} from '../src/services/triality-confidence.js';
import { resetDb, startTestServer, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

/**
 * Triality T7 — the measurement surface (design §9.2). Honest-zero rules under
 * test: no shown rows ⇒ null rate (never 0%), pending (<24h, still-shown) rows
 * excluded from denominators, weights null until the learning job writes rows,
 * and the flag-off 404.
 *
 * v2.2 adds the confidence calibration tile — the same rules, plus two the band
 * grid introduces: a row this version cannot READ (pre-v2.2 NULL, an off-enum
 * band, an earlier model version) is disclosed separately and never folded into
 * a band, and the whole grid collapses impressions before it counts anything.
 */

let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z');

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

/** |meta.active| with work hours configured (§2). Inert for this reader — bandCalibration
 *  looks at `band` and `v` and nothing else — but the blob is written WHOLE so a fixture
 *  can never be a shape production does not produce. */
const FIXTURE_DIMS_ACTIVE = 12;

/**
 * Evidence rows that land a blob's `value` in each band, derived from the band constants
 * rather than written down, so the fixtures move when FIRM_AT / TENTATIVE_AT move.
 * Evidence is the component the fixture varies because it is the only one with an exact
 * integer basis (rows / EVIDENCE_FULL); coverage and margin sit saturated at 1.
 */
const EVIDENCE_ROWS_FOR: Record<string, number> = {
  firm: Math.ceil(FIRM_AT * EVIDENCE_FULL),
  tentative: Math.ceil(TENTATIVE_AT * EVIDENCE_FULL),
  guess: 0,
};

/**
 * A stored confidence blob shaped exactly like `scoreConfidence`'s output: `value ===
 * min(coverage, margin, evidence)` and `band === bandFor(value)` both hold. That
 * self-consistency is load-bearing rather than decorative — a fixture asserting a band the
 * arithmetic would never produce would let every case below keep passing against a reader
 * that had stopped agreeing with the writer.
 *
 * `band` is a plain string ON PURPOSE: the hand-edited off-enum row has to travel this
 * same path, because a fixture that cannot express a corrupt row cannot prove the reader
 * rejects one.
 */
function confidenceJson(band: string, v = CONFIDENCE_MODEL_VERSION): string {
  const evidenceRows = EVIDENCE_ROWS_FOR[band] ?? 0;
  const evidence = evidenceRows / EVIDENCE_FULL;
  return JSON.stringify({
    band,
    value: evidence,
    coverage: 1,
    margin: 1,
    evidence,
    marginBasis: 'dot',
    binding: 'evidence',
    counts: {
      dimsInformative: FIXTURE_DIMS_ACTIVE,
      dimsActive: FIXTURE_DIMS_ACTIVE,
      evidenceRows,
      eligible: 3,
    },
    v,
  });
}

// Distinct action_ref per row BY DEFAULT: the tile now collapses impressions the
// same way learning does (one vote per slot/action/day), so a shared ref means
// "the same suggestion re-shown", which is opt-in for the tests that mean it.
//
// `band` omitted writes NULL — the pre-v2.2 row, which is what every case written
// before this wave keeps exercising.
let rowSeq = 0;
function logRow(o: { slot?: string; outcome?: string; ageHours?: number; ref?: string; kind?: string; owner?: string; band?: string; v?: number }): void {
  const shownAt = new Date(NOW.getTime() - (o.ageHours ?? 48) * 3600_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores, outcome, confidence)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(
      o.owner ?? OWNER, shownAt, shownAt.slice(0, 10), o.slot ?? 'habitual', o.kind ?? 'task',
      o.ref ?? `ref-${++rowSeq}`, o.outcome ?? 'shown',
      o.band === undefined ? null : confidenceJson(o.band, o.v),
    );
}

/**
 * A row the LEARNING job can use: real component scores, and a distinct
 * `action_ref` per row — learning collapses one (slot, action_ref, local_date)
 * group to a single vote, so a shared ref would make N rows one piece of evidence.
 *
 * Writes NO confidence, deliberately: v2.2 leaves the learning corpus untouched, and
 * these rows exist to drive `calibrateTriality`, which reads `scores` and never this
 * column. A corpus built only from them measures nothing about confidence — which is
 * the honest reading of pre-v2.2 evidence, not a gap in the fixture.
 */
let learnSeq = 0;
function logLearnable(o: { outcome: string; scores: Record<string, number>; ageDays: number }): void {
  const shownAt = new Date(NOW.getTime() - o.ageDays * 86_400_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores, outcome, outcome_at)
       VALUES (uuid7(), ?, ?, ?, 'habitual', 'task', ?, ?, ?, ?)`,
    )
    .run(OWNER, shownAt, shownAt.slice(0, 10), `learn-${++learnSeq}`, JSON.stringify(o.scores), o.outcome, shownAt);
}

describe('acceptance math', () => {
  it('taken/(decided) per slot; pending <24h rows excluded from the denominator', () => {
    logRow({ slot: 'habitual', outcome: 'staged' });
    logRow({ slot: 'habitual', outcome: 'opened' });
    logRow({ slot: 'habitual', outcome: 'dismissed' });
    logRow({ slot: 'habitual', outcome: 'shown', ageHours: 48 }); // ignored — counts, not taken
    logRow({ slot: 'habitual', outcome: 'shown', ageHours: 2 });  // pending — excluded entirely
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.acceptance.habitual).toEqual({ shown: 4, taken: 2, pending: 1, rate: 0.5 });
  });

  it('remount spam is ONE vote in the tile, exactly as it is in learning', () => {
    // The prover's finding: the log has two readers, and the tile was still
    // counting raw impressions — a day of banner remounts reported hundreds of
    // "shown" for a handful of real suggestions and understated acceptance ~3×.
    for (let i = 0; i < 40; i++) logRow({ slot: 'habitual', outcome: 'shown', ageHours: 2, ref: 'same-pick' });
    logRow({ slot: 'habitual', outcome: 'staged', ageHours: 2, ref: 'same-pick' }); // the decision wins the group
    logRow({ slot: 'habitual', outcome: 'dismissed', ageHours: 3, ref: 'other-pick' });
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.acceptance.habitual).toEqual({ shown: 2, taken: 1, pending: 0, rate: 0.5 });
  });

  it('no shown rows ⇒ null rate — no data is not 0%', () => {
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.acceptance.habitual.rate).toBeNull();
    expect(m.acceptance.novel.rate).toBeNull();
    expect(m.novelTrend).toEqual({ current: null, prior: null });
  });

  it('novel trend compares this window against the prior same-length window', () => {
    logRow({ slot: 'novel', outcome: 'staged', ageHours: 24 * 5 });      // current window: 1/1
    logRow({ slot: 'novel', outcome: 'dismissed', ageHours: 24 * 40 });  // prior window: 0/1
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.novelTrend.current).toBe(1);
    expect(m.novelTrend.prior).toBe(0);
  });
});

describe('confidence calibration', () => {
  /** The tile, with the null guard spent once. Every case here seeds at least one row
   *  this version can read, so a null return is a failure rather than a state. */
  function cal(): TrialityCalibration {
    const c = trialityMetrics(OWNER, NOW, 30).calibration;
    expect(c).not.toBeNull();
    return c as TrialityCalibration;
  }

  const bandStats = (c: TrialityCalibration, b: string): ConfidenceBandStats =>
    c.bands.find((x) => x.band === b) as ConfidenceBandStats;

  /** Collapsed groups this version could read AND credit to a band. Every "counts as
   *  ONE" and "never buckets" assertion is really a claim about this number. */
  const credited = (c: TrialityCalibration): number =>
    c.bands.reduce((n, b) => n + b.shown + b.pending, 0);

  /** Age in hours of an instant, against the FROZEN NOW — so a fixture can name the
   *  owner-local hour it means (09:00 vs 16:00) instead of an opaque offset. */
  const ageOf = (iso: string): number => (NOW.getTime() - Date.parse(iso)) / 3_600_000;

  /** Staged rows producing exactly `rate` out of a floor-sized band. The integer check is
   *  the point: a change to OUTCOME_FLOOR fails HERE, in the fixture, instead of surfacing
   *  as an unexplained rate mismatch three assertions later. */
  function takenFor(rate: number): number {
    const n = OUTCOME_FLOOR * rate;
    expect(Number.isInteger(n)).toBe(true);
    return n;
  }

  /** `decided` rows in one band, `taken` of them staged and the rest dismissed. Refs are
   *  distinct, so nothing collapses and the decided count is exactly what the tile reads. */
  function seedBand(band: string, o: { decided: number; taken: number; slot?: string }): void {
    for (let i = 0; i < o.decided; i++) {
      logRow({ slot: o.slot, band, outcome: i < o.taken ? 'staged' : 'dismissed' });
    }
  }

  it('the fixture blob is the shape production writes', () => {
    // Guards every case below. If the fixture drifted from scoreConfidence's arithmetic —
    // a band naming a value that would not produce it — the rest of this block would keep
    // passing while measuring nothing.
    for (const b of ['firm', 'tentative', 'guess'] as const) {
      const c = parseConfidence(confidenceJson(b));
      expect(c).not.toBeNull();
      expect(c!.band).toBe(b);
      expect(c!.value).toBe(Math.min(c!.coverage, c!.margin, c!.evidence));
      expect(bandFor(c!.value)).toBe(b);
      expect(c!.v).toBe(CONFIDENCE_MODEL_VERSION);
    }
    expect(parseConfidence(confidenceJson('solid'))).toBeNull();
  });

  it('calibration collapses impressions — 40 remounts of one suggestion are ONE row, in ONE band', () => {
    // The ~3× inflation this file already fixed once for `acceptance`, now arriving at a
    // THIRD reader of triality_log. GET /next appends three fresh rows and the banner
    // refetches on every mount, so a per-band rate over RAW rows would inflate exactly the
    // bands the owner sees most — inside the one metric whose entire job is detecting that
    // the confidence model lies.
    const REMOUNTS = 40;
    for (let i = 0; i < REMOUNTS; i++) {
      logRow({ band: 'firm', outcome: 'shown', ageHours: 2, ref: 'same-pick' });
    }
    logRow({ band: 'firm', outcome: 'staged', ageHours: 2, ref: 'same-pick' }); // the decision wins the group

    const c = cal();
    expect(bandStats(c, 'firm')).toMatchObject({ shown: 1, taken: 1, pending: 0, rate: 1 });
    expect(credited(c)).toBe(1);
    expect(c.unbanded + c.otherModel).toBe(0);
    // …and the two tiles stay one vote apiece: divergent counts here would make the
    // calibration grid dispute the acceptance grid it sits under.
    expect(trialityMetrics(OWNER, NOW, 30).acceptance.habitual.shown).toBe(1);
  });

  it('NULL-confidence rows land in unbanded only — never coerced to guess', () => {
    seedBand('firm', { decided: 3, taken: 3 });
    logRow({ outcome: 'staged' });                 // pre-v2.2: shown before the column existed
    logRow({ outcome: 'dismissed' });
    logRow({ outcome: 'shown', ageHours: 2 });     // pending — and not a BAND's pending either

    const c = cal();
    expect(c.unbanded).toBe(3);
    expect(c.otherModel).toBe(0);
    expect(bandStats(c, 'firm')).toMatchObject({ shown: 3, taken: 3, pending: 0, rate: 1 });
    for (const b of ['tentative', 'guess']) {
      expect(bandStats(c, b)).toMatchObject({ shown: 0, taken: 0, pending: 0, rate: null });
    }
    expect(credited(c)).toBe(3);
  });

  it('a window of only NULL-confidence rows reports no calibration at all', () => {
    // Not a three-band grid of zeros: pre-v2.2 rows skew toward the feature's earliest
    // period, so a rendered grid would read as "the bands were measured and found equal".
    logRow({ outcome: 'staged' });
    logRow({ outcome: 'dismissed' });
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.calibration).toBeNull();
    expect(m.acceptance.habitual.shown).toBe(2); // …while the tile above still sees them
  });

  it('version-mismatched rows land in otherModel only', () => {
    // They claim `firm`, which is the whole risk: a retune that kept the same band names
    // would silently pool two models' evidence and destroy what motivated the retune.
    const EARLIER_MODEL = CONFIDENCE_MODEL_VERSION - 1;
    seedBand('firm', { decided: 2, taken: 2 });
    for (let i = 0; i < 4; i++) logRow({ band: 'firm', outcome: 'staged', v: EARLIER_MODEL });

    const c = cal();
    expect(c.otherModel).toBe(4);
    expect(c.unbanded).toBe(0);
    expect(bandStats(c, 'firm')).toMatchObject({ shown: 2, taken: 2, rate: 1 });
    expect(credited(c)).toBe(2);
  });

  it('a window of ONLY older-model rows still returns a payload, so the disclosure renders', () => {
    // The null guard keys on `unbanded === rows.length`, not on "no current-model rows",
    // and that distinction is the whole point of shipping a version at all. Tighten it to
    // `unbanded + otherModel === rows.length` — a natural-looking simplification, since
    // neither cohort feeds a band — and every other test here stays green while the
    // scenario the version field exists FOR quietly breaks: immediately after a
    // CONFIDENCE_MODEL_VERSION bump the window holds nothing but orphaned rows, the tile
    // falls back to "shown before confidence scoring" (false — they were scored, by the
    // previous model), and the `{n} scored by an earlier confidence model` line never
    // renders. Null means "confidence isn't measured yet", which is a different claim.
    const EARLIER_MODEL = CONFIDENCE_MODEL_VERSION - 1;
    for (let i = 0; i < 5; i++) logRow({ band: 'firm', outcome: 'staged', v: EARLIER_MODEL });

    const c = cal();
    expect(c.otherModel).toBe(5);
    expect(c.unbanded).toBe(0);
    expect(c.verdict).toBe('insufficient');
    for (const b of c.bands) expect(b).toMatchObject({ shown: 0, taken: 0, rate: null });
  });

  it('pending is drawn at the same 24h line as acceptance — both tiles agree on one corpus', () => {
    const PENDING_HOURS = PENDING_MS / 3_600_000;
    logRow({ band: 'firm', outcome: 'staged' });
    logRow({ band: 'firm', outcome: 'dismissed' });
    logRow({ band: 'firm', outcome: 'shown', ageHours: PENDING_HOURS });     // AT the line ⇒ ignored, decided
    logRow({ band: 'firm', outcome: 'shown', ageHours: PENDING_HOURS - 1 }); // inside it ⇒ pending

    const m = trialityMetrics(OWNER, NOW, 30);
    const f = bandStats(m.calibration as TrialityCalibration, 'firm');
    expect(m.acceptance.habitual).toEqual({ shown: 3, taken: 1, pending: 1, rate: 0.333 });
    expect({ shown: f.shown, taken: f.taken, pending: f.pending, rate: f.rate })
      .toEqual(m.acceptance.habitual);
  });

  it('honest zeros: no rows ⇒ no calibration; a band with nothing decided ⇒ null rate, not 0%', () => {
    expect(trialityMetrics(OWNER, NOW, 30).calibration).toBeNull();

    seedBand('firm', { decided: 2, taken: 2 });
    logRow({ band: 'tentative', outcome: 'shown', ageHours: 2 }); // pending only — nothing decided
    seedBand('guess', { decided: 2, taken: 0 });

    const c = cal();
    expect(bandStats(c, 'tentative')).toMatchObject({ shown: 0, taken: 0, pending: 1, rate: null });
    // A band that WAS decided and never taken is a real 0%, and it must stay
    // distinguishable from the null above — that difference is the whole honest-zero rule.
    expect(bandStats(c, 'guess')).toMatchObject({ shown: 2, taken: 0, pending: 0, rate: 0 });
  });

  it('verdict: insufficient until two bands clear the floor', () => {
    seedBand('firm', { decided: OUTCOME_FLOOR, taken: OUTCOME_FLOOR });
    seedBand('tentative', { decided: OUTCOME_FLOOR - 1, taken: 0 });

    const c = cal();
    expect(c.floor).toBe(OUTCOME_FLOOR);
    expect(c.verdict).toBe('insufficient');
    // The floor gates the COMPARISON, not the numbers: both rates still compute and still
    // render, and the boundary is inclusive — firm sits exactly on it and is present.
    expect(bandStats(c, 'firm').rate).toBe(1);
    expect(bandStats(c, 'tentative').rate).toBe(0);
    expect(c.confounded).toBe(false);
  });

  it('verdict: ordered when every adjacent band is taken less than the one above it', () => {
    seedBand('firm', { decided: OUTCOME_FLOOR, taken: takenFor(0.8) });
    seedBand('tentative', { decided: OUTCOME_FLOOR, taken: takenFor(0.5) });
    seedBand('guess', { decided: OUTCOME_FLOOR, taken: takenFor(0.2) });

    const c = cal();
    expect(c.bands.map((b) => b.band)).toEqual(['firm', 'tentative', 'guess']);
    expect(c.verdict).toBe('ordered');
    expect(bandStats(c, 'firm').rate! - bandStats(c, 'tentative').rate!).toBeGreaterThanOrEqual(c.minGap);
    expect(bandStats(c, 'tentative').rate! - bandStats(c, 'guess').rate!).toBeGreaterThanOrEqual(c.minGap);
  });

  it('verdict: flat when no adjacent gap clears minGap', () => {
    seedBand('firm', { decided: OUTCOME_FLOOR, taken: takenFor(0.55) });
    seedBand('tentative', { decided: OUTCOME_FLOOR, taken: takenFor(0.5) });
    seedBand('guess', { decided: OUTCOME_FLOOR, taken: takenFor(0.5) });

    const c = cal();
    expect(c.verdict).toBe('flat');
    // Ranked in the right ORDER and still flat: an ordering smaller than minGap is one
    // flipped outcome wide, so calling it a result would be reading noise.
    expect(bandStats(c, 'firm').rate! - bandStats(c, 'tentative').rate!).toBeLessThan(c.minGap);
  });

  it('verdict: inverted when the ordering runs backwards', () => {
    seedBand('firm', { decided: OUTCOME_FLOOR, taken: takenFor(0.2) });
    seedBand('tentative', { decided: OUTCOME_FLOOR, taken: takenFor(0.5) });
    seedBand('guess', { decided: OUTCOME_FLOOR, taken: takenFor(0.8) });

    expect(cal().verdict).toBe('inverted');
  });

  it('inverted beats ordered — the scan is over ADJACENT pairs, not the extremes', () => {
    seedBand('firm', { decided: OUTCOME_FLOOR, taken: takenFor(0.2) });
    seedBand('tentative', { decided: OUTCOME_FLOOR, taken: takenFor(0.6) });
    seedBand('guess', { decided: OUTCOME_FLOOR, taken: takenFor(0.1) });

    const c = cal();
    // firm-vs-guess alone spans the gap in the right direction, so an extremes-only scan
    // would report `ordered` on a model that is visibly backwards at its first step.
    expect(bandStats(c, 'firm').rate! - bandStats(c, 'guess').rate!).toBeGreaterThanOrEqual(c.minGap);
    expect(c.verdict).toBe('inverted');
  });

  it('a middle-band inversion is caught', () => {
    seedBand('firm', { decided: OUTCOME_FLOOR, taken: takenFor(0.6) });
    seedBand('tentative', { decided: OUTCOME_FLOOR, taken: takenFor(0.2) });
    seedBand('guess', { decided: OUTCOME_FLOOR, taken: takenFor(0.45) });

    const c = cal();
    // The outer pair is ordered and the first adjacent pair is ordered — only
    // tentative-vs-guess is reversed, and that alone is the model falsifying itself.
    expect(bandStats(c, 'firm').rate! - bandStats(c, 'guess').rate!).toBeGreaterThanOrEqual(c.minGap);
    expect(bandStats(c, 'firm').rate! - bandStats(c, 'tentative').rate!).toBeGreaterThanOrEqual(c.minGap);
    expect(c.verdict).toBe('inverted');
  });

  // A real mix in both bands, never the mode — so `confounded` is testing the MODAL slot
  // rather than a slot-pure fixture that could not tell the two apart.
  const MINORITY = 5;
  const MAJORITY = OUTCOME_FLOOR - MINORITY;

  it('confounded when the top and bottom bands are dominated by different slots', () => {
    // firm is Habitual-heavy and guess Novel-heavy BY CONSTRUCTION — Novel's veto selects
    // the low-H, low-evidence tail — so an `ordered` verdict here may be the slot effect
    // the acceptance grid already shows rather than confidence working. The flag says so.
    seedBand('firm', { decided: MAJORITY, taken: MAJORITY, slot: 'habitual' });
    seedBand('firm', { decided: MINORITY, taken: 0, slot: 'contextual' });
    seedBand('guess', { decided: MAJORITY, taken: 0, slot: 'novel' });
    seedBand('guess', { decided: MINORITY, taken: MINORITY, slot: 'contextual' });

    const c = cal();
    expect(bandStats(c, 'firm').slotMix).toEqual({ habitual: MAJORITY, contextual: MINORITY, novel: 0 });
    expect(bandStats(c, 'guess').slotMix).toEqual({ habitual: 0, contextual: MINORITY, novel: MAJORITY });
    expect(c.verdict).toBe('ordered');   // …and confounded rides ON TOP of a passing verdict
    expect(c.confounded).toBe(true);
  });

  it('not confounded when both ends share a modal slot', () => {
    seedBand('firm', { decided: MAJORITY, taken: MAJORITY, slot: 'habitual' });
    seedBand('firm', { decided: MINORITY, taken: 0, slot: 'novel' });
    seedBand('guess', { decided: MAJORITY, taken: 0, slot: 'habitual' });
    seedBand('guess', { decided: MINORITY, taken: 0, slot: 'novel' });

    const c = cal();
    expect(c.confounded).toBe(false);
  });

  it('a group whose impressions carry different bands is credited to the representative the collapse kept', () => {
    // One suggestion, one owner-local day, two readings: in_work_hours, momentum and
    // free_gap all move within a day, so the two bands genuinely differ. The credited band
    // is the one on the row the collapse KEPT — never averaged, never re-derived.
    const REF = 'shown-twice';
    logRow({ ref: REF, band: 'firm', outcome: 'shown', ageHours: ageOf('2026-07-28T09:00:00.000Z') });
    logRow({ ref: REF, band: 'tentative', outcome: 'staged', ageHours: ageOf('2026-07-28T16:00:00.000Z') });

    const c = cal();
    expect(credited(c)).toBe(1);
    // The 16:00 reading is the one that was in front of the owner when they decided.
    expect(bandStats(c, 'tentative')).toMatchObject({ shown: 1, taken: 1, pending: 0, rate: 1 });
    expect(bandStats(c, 'firm')).toMatchObject({ shown: 0, taken: 0, pending: 0, rate: null });
  });

  it('an off-enum band never buckets — it counts as unbanded', () => {
    // Hand-edited, or written by a future version this one cannot interpret. Either way it
    // is not a reading, and the honest place for it is the same disclosure line as a
    // pre-v2.2 NULL — never `guess`, which is a positive claim about a real pick.
    seedBand('firm', { decided: 2, taken: 2 });
    for (let i = 0; i < 3; i++) logRow({ band: 'solid', outcome: 'staged' });

    const c = cal();
    expect(c.unbanded).toBe(3);
    expect(c.otherModel).toBe(0);
    expect(credited(c)).toBe(2);
    expect(bandStats(c, 'guess')).toMatchObject({ shown: 0, taken: 0, pending: 0, rate: null });
  });
});

describe('weights', () => {
  it('returns null while there are no learned ROWS yet — endpoint still whole', () => {
    // Migration 0142 always creates triality_weights, so "not started" is an EMPTY
    // table, never a missing one — and null (not []) is what the tile keys its
    // "learning hasn't started" state on. A reset lands back in exactly this state.
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.weights).toBeNull();
  });

  it('learned weights reach the tile with slot, sampleCount and computedDate', async () => {
    // Populated through the real learning job, so the shape under test is the one
    // the job actually writes (rather than a hand-built row that could drift).
    for (let i = 0; i < 10; i++) {
      logLearnable({ outcome: 'staged', scores: { F: 1, H: 0, Q: 0.5 }, ageDays: 3 + i });
      logLearnable({ outcome: 'dismissed', scores: { F: 0, H: 1, Q: 0.5 }, ageDays: 3 + i });
    }
    expect(calibrateTriality(OWNER, NOW).slotsWritten).toBe(1);

    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.weights).toHaveLength(1);
    const row = m.weights![0]!;
    expect(row.slot).toBe('habitual');
    expect(row.sampleCount).toBe(20);
    expect(row.computedDate).toBe(NOW.toISOString().slice(0, 10)); // owner-local day (UTC prefs)
    expect(row.weights.F).toBeCloseTo(0.5, 12);  // 0.40 · (1 + 0.5·+0.5)
    expect(row.weights.H).toBeCloseTo(0.3, 12);
    expect(Object.keys(row.weights)).toEqual(['F', 'H', 'Q', 'N', 'C']);

    // …and it survives the round trip through the route the Balance tab calls.
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    const res = await api(srv.url, '/api/metrics/triality?days=30');
    expect(res.status).toBe(200);
    expect(res.body.weights).toEqual(m.weights);
  });

  it('null again after the learned rows go — a reset is indistinguishable from never having learned', () => {
    logLearnable({ outcome: 'staged', scores: { F: 1, H: 0, Q: 0.5 }, ageDays: 3 });
    for (let i = 0; i < 19; i++) {
      logLearnable({ outcome: i % 2 ? 'staged' : 'dismissed', scores: { F: i % 2, H: 0.5, Q: 0.5 }, ageDays: 4 + i });
    }
    calibrateTriality(OWNER, NOW);
    expect(trialityMetrics(OWNER, NOW, 30).weights).not.toBeNull();
    sqlite.prepare(`DELETE FROM triality_weights WHERE owner_id = ?`).run(OWNER);
    expect(trialityMetrics(OWNER, NOW, 30).weights).toBeNull();
  });
});

describe('route', () => {
  it('404 while the flag is off; 200 with the payload when on', async () => {
    expect((await api(srv.url, '/api/metrics/triality')).status).toBe(404);
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    const res = await api(srv.url, '/api/metrics/triality?days=30');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.acceptance.contextual.rate).toBeNull();
  });

  it('calibration reaches the wire with the field names the client reads', async () => {
    // The whole calibration surface rests on one untested sentence in the spec — "the
    // route returns trialityMetrics verbatim and needs no edit". Every other assertion
    // in this file calls the service in-process and the client tiles test feeds a
    // hand-built fixture, so between them nothing pins that the object actually ships,
    // or that its keys are the ones TrialityCalibration declares.
    //
    // That gap is quietly dangerous because this is the ONE Triality REST payload that
    // ships camelCase verbatim — `/next` hand-maps every field to snake_case in
    // pickToApi. Anyone reconciling the two (a whitelist on the route, a rename to
    // `other_model`) would leave both suites green and the tile rendering
    // "firm 0 · tentative 0 · guess 0 decided" with an undefined verdict: the one metric
    // this wave exists to produce, silently blank.
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    logRow({ slot: 'habitual', outcome: 'staged', band: 'firm' });
    logRow({ slot: 'novel', outcome: 'dismissed', band: 'guess' });

    const res = await api(srv.url, '/api/metrics/triality?days=30');
    expect(res.status).toBe(200);
    const cal = res.body.calibration as TrialityCalibration;
    expect(cal).toBeTruthy();
    // Keys, not just presence: a rename is exactly what this test exists to catch.
    expect(Object.keys(cal).sort()).toEqual(
      ['bands', 'confounded', 'floor', 'minGap', 'otherModel', 'unbanded', 'verdict'].sort(),
    );
    expect(cal.bands.map((b) => b.band)).toEqual(['firm', 'tentative', 'guess']);
    expect(Object.keys(cal.bands[0]).sort()).toEqual(
      ['band', 'pending', 'rate', 'shown', 'slotMix', 'taken'].sort(),
    );
    expect(Object.keys(cal.bands[0].slotMix).sort()).toEqual(['contextual', 'habitual', 'novel']);
    // Two decided rows, well under the floor — the honest answer is "not enough yet",
    // never a verdict computed from two samples.
    expect(cal.verdict).toBe('insufficient');
    expect(cal.floor).toBe(OUTCOME_FLOOR);
    expect(cal.bands.find((b) => b.band === 'firm')!.rate).toBe(1);
    expect(cal.bands.find((b) => b.band === 'tentative')!.rate).toBeNull();
  });

  it('cross-tenant: B sees only B', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    createOwner(SECOND_OWNER_ID);
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(SECOND_OWNER_ID);
    logRow({ slot: 'habitual', outcome: 'staged', owner: OWNER });
    const b = await api(srv.url, '/api/metrics/triality', { headers: { 'x-test-owner': SECOND_OWNER_ID } });
    expect(b.status).toBe(200);
    expect(b.body.acceptance.habitual.rate).toBeNull(); // A's rows invisible to B
  });

  it('existing /api/metrics/tasks response shape untouched (snapshot-lite)', async () => {
    const res = await api(srv.url, '/api/metrics/tasks?days=30');
    expect(res.status).toBe(200);
    for (const k of ['window', 'directions', 'categories', 'totals']) expect(k in res.body).toBe(true);
    expect('acceptance' in res.body).toBe(false);
  });
});
