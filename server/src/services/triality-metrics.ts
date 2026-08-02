import { store } from '../db/store.js';
import { buildSituationVector } from './triality-vector.js';
import { collapseImpressions, OUTCOME_FLOOR, PENDING_MS } from './triality-learning.js';
import { CONFIDENCE_MODEL_VERSION, parseConfidence, type ConfidenceBand } from './triality-confidence.js';
import { SLOTS, type Slot } from './triality.js';

/**
 * Triality measurement surface (design §9.2) — what the suggestions DID,
 * measured from triality_log (+ triality_weights once the learning wave lands).
 * Read-only; the honest-zero tile rule applies throughout: zero shown rows is
 * "no data", never a 0% rate, and slots below sample floors return null rates.
 *
 * Window semantics: `days` clamps 1..365 (the task-metrics convention). A row
 * still `shown` but younger than 24h is PENDING — undecided, excluded from
 * acceptance denominators; older unactioned rows count as ignored (§6b's
 * reward map draws the same line).
 */

/** Decided rows a BAND needs before its rate enters the verdict. Reuses §6b's number
 *  rather than inventing a fourth floor, and the two arguments cancel: this tile only
 *  ORDERS three rates (weaker than fitting a covariance, which argues for less), but
 *  coverage is PER-VECTOR, so whenever it binds all three picks of one impression carry
 *  the same band and rows within a band are correlated at roughly n/3 effective (which
 *  argues for more). */
const CALIBRATION_FLOOR = OUTCOME_FLOOR;

/** Rate gap below which two bands are "the same". At the floor one flipped outcome moves
 *  a rate by 1/20 = 0.05, and correlated rows often flip in threes — so a smaller spread
 *  is literally within one impression's leverage, and calling it an ordering would be
 *  reading noise as a result. */
const CALIBRATION_MIN_GAP = 0.1;

/** Rendering order, and the order the verdict scans adjacent pairs in. */
const BANDS = ['firm', 'tentative', 'guess'] as const;

export type CalibrationVerdict = 'insufficient' | 'ordered' | 'flat' | 'inverted';

export interface ConfidenceBandStats {
  band: ConfidenceBand;
  shown: number;       // decided rows (pending excluded) — SlotAcceptance's exact rule
  taken: number;       // staged + opened
  pending: number;     // still-shown, <24h
  rate: number | null; // taken/shown, null when shown === 0 — no data is not 0%
  /** Decided rows per slot. Disclosed because firm will be Habitual-heavy and guess
   *  Novel-heavy BY CONSTRUCTION (Novel's veto selects the low-H, low-evidence tail), so
   *  an `ordered` verdict may be the slot effect the tiles above already show. */
  slotMix: Record<Slot, number>;
}

export interface TrialityCalibration {
  bands: ConfidenceBandStats[]; // always three, firm → tentative → guess
  /** Collapsed groups whose row carries no confidence — shown before v2.2. Counted
   *  separately and NEVER coerced to `guess`: those rows skew toward the feature's
   *  earliest period, so folding them in would bias the very comparison this measures. */
  unbanded: number;
  /** Scored by a different CONFIDENCE_MODEL_VERSION — excluded so a retune cannot
   *  silently destroy the evidence that motivated it. */
  otherModel: number;
  floor: number;
  minGap: number;
  verdict: CalibrationVerdict;
  confounded: boolean;
}

export interface SlotAcceptance {
  shown: number;      // decided rows (pending excluded)
  taken: number;      // staged + opened
  pending: number;    // still-shown, <24h — not yet evidence
  rate: number | null; // taken/shown, null when shown === 0
}

export interface TrialityMetrics {
  windowDays: number;
  acceptance: Record<Slot, SlotAcceptance>;
  novelTrend: { current: number | null; prior: number | null };
  deficitResponse: Array<{
    category: string;
    takenPicks: number;
    currentShare: number | null; // timed-minutes share this window
    priorShare: number | null;   // …and the window before it
  }>;
  /** null until triality_weights exists AND has rows (T8) — the tile renders
   *  its "learning not started" state on null. */
  weights: Array<{ slot: string; weights: Record<string, number>; sampleCount: number; computedDate: string }> | null;
  /** v2.2 (§4): do `firm` picks actually get taken more than `tentative` ones? null when
   *  no row in the window carries a confidence at all. If the ordering is INVERTED the
   *  confidence model is wrong, and this is what says so. */
  calibration: TrialityCalibration | null;
}

async function slotAcceptance(ownerId: string, slot: Slot, fromISO: string, toISO: string, now: Date): Promise<SlotAcceptance> {
  const raw = await store()
    .prepare(
      `SELECT outcome, shown_at, action_ref, local_date FROM triality_log
        WHERE owner_id = ? AND slot = ? AND shown_at >= ? AND shown_at < ?
        ORDER BY id ASC`,
    )
    .all<{ outcome: string; shown_at: string; action_ref: string; local_date: string }>(ownerId, slot, fromISO, toISO);
  // SAME collapse the learning job applies (one vote per suggestion per day, a
  // decision beats an impression, else the EARLIEST showing represents the group).
  // The log has TWO readers, and an independent prover caught this one still
  // counting raw impressions: a day of banner remounts reported hundreds of
  // "shown" for eight real suggestions and understated the acceptance rate ~3×.
  // Whatever the learning corpus calls one vote, the tile must call one vote —
  // divergent counts here would make the metrics dispute the weights they explain.
  const rows = collapseImpressions(raw.map((r) => ({ ...r, slot, scores: '' })));
  let taken = 0, pending = 0, decided = 0;
  for (const r of rows) {
    if (r.outcome === 'shown' && now.getTime() - Date.parse(r.shown_at) < PENDING_MS) { pending++; continue; }
    decided++;
    if (r.outcome === 'staged' || r.outcome === 'opened') taken++;
  }
  return { shown: decided, taken, pending, rate: decided > 0 ? Math.round((taken / decided) * 1000) / 1000 : null };
}

/**
 * Acceptance grouped by confidence band — the tile whose entire purpose is to falsify
 * the confidence model (v2.2 §4). If `firm` picks are not taken more often than
 * `tentative` ones, the bands are decoration and this says so out loud.
 *
 * `collapseImpressions` is MANDATORY here, and this is the THIRD reader of triality_log.
 * The comment above slotAcceptance records why: an independent prover caught this file
 * counting raw impressions, and a day of banner remounts reported hundreds of "shown"
 * for eight real suggestions, understating acceptance roughly 3×. The banner refetches
 * on every mount and GET /next appends three fresh rows each time — so a per-band rate
 * over raw rows would reproduce that bug in the one metric that exists to detect the
 * model lying, and would inflate exactly the bands the owner sees most.
 *
 * WHICH impression's band gets credit: the collapse keeps one representative per
 * (slot, action, owner-local day) — a decision beats an impression, else the earliest
 * `shown`. The same suggestion re-shown at 09:00 and 16:00 can carry DIFFERENT bands
 * (in_work_hours, momentum and free_gap all move within a day). The credited band is the
 * band on the row the collapse KEPT — never averaged, never re-derived. That is correct
 * on both arms: a decided representative carries the reading that was in front of the
 * owner when they decided, and an earliest-shown representative carries the reading they
 * had for the whole span the pending-vs-ignored judgement measures.
 */
async function bandCalibration(ownerId: string, fromISO: string, toISO: string, now: Date): Promise<TrialityCalibration | null> {
  const raw = await store()
    .prepare(
      `SELECT slot, outcome, shown_at, action_ref, local_date, confidence FROM triality_log
        WHERE owner_id = ? AND shown_at >= ? AND shown_at < ?
        ORDER BY id ASC`,
    )
    .all<{
      slot: string; outcome: string; shown_at: string; action_ref: string;
      local_date: string; confidence: string | null;
    }>(ownerId, fromISO, toISO);
  if (raw.length === 0) return null;

  const rows = collapseImpressions(raw.map((r) => ({ ...r, scores: '' })));

  const emptySlotMix = (): Record<Slot, number> =>
    Object.fromEntries(SLOTS.map((s) => [s, 0])) as Record<Slot, number>;
  const stats = Object.fromEntries(
    BANDS.map((b) => [b, { band: b, shown: 0, taken: 0, pending: 0, rate: null, slotMix: emptySlotMix() } as ConfidenceBandStats]),
  ) as Record<ConfidenceBand, ConfidenceBandStats>;

  let unbanded = 0;
  let otherModel = 0;
  for (const r of rows) {
    // An unparseable or off-enum band is indistinguishable from a pre-v2.2 row for our
    // purposes: it is not a reading this version can interpret, so it never buckets.
    const c = parseConfidence(r.confidence);
    if (!c) { unbanded++; continue; }
    if (c.v !== CONFIDENCE_MODEL_VERSION) { otherModel++; continue; }
    const s = stats[c.band];
    // The exact pending/decided line SlotAcceptance draws, from the one imported constant.
    if (r.outcome === 'shown' && now.getTime() - Date.parse(r.shown_at) < PENDING_MS) { s.pending++; continue; }
    s.shown++;
    if (SLOTS.includes(r.slot as Slot)) s.slotMix[r.slot as Slot]++;
    if (r.outcome === 'staged' || r.outcome === 'opened') s.taken++;
  }
  // Null means "confidence isn't measured yet", so it must key on whether any row CARRIES
  // a confidence — not on whether any row carries a CURRENT-MODEL one. A window holding
  // only older-model rows still has something to disclose (`otherModel`), and collapsing
  // that to null would hide the fact that a retune orphaned the evidence.
  if (unbanded === rows.length) return null;

  for (const b of BANDS) {
    const s = stats[b];
    s.rate = s.shown > 0 ? Math.round((s.taken / s.shown) * 1000) / 1000 : null;
  }

  // Verdict on the ROUNDED rates, so it is hand-checkable from what actually renders.
  const present = BANDS.filter((b) => stats[b].shown >= CALIBRATION_FLOOR);
  let verdict: CalibrationVerdict = 'insufficient';
  if (present.length >= 2) {
    let inverted = false;
    let ordered = true;
    // ADJACENT pairs, not the extremes: a middle-band inversion is still the model
    // falsifying itself, and comparing only firm-vs-guess would hide it.
    for (let i = 1; i < present.length; i++) {
      const hi = stats[present[i - 1]].rate as number;
      const lo = stats[present[i]].rate as number;
      if (lo - hi >= CALIBRATION_MIN_GAP) inverted = true;
      if (!(hi - lo >= CALIBRATION_MIN_GAP)) ordered = false;
    }
    // `inverted` beats `ordered`: if ANY adjacent pair is reversed beyond the gap, the
    // model does not get to claim it works because a different pair happened to line up.
    verdict = inverted ? 'inverted' : ordered ? 'ordered' : 'flat';
  }

  const modalSlot = (b: ConfidenceBand): Slot =>
    SLOTS.reduce((best, s) => (stats[b].slotMix[s] > stats[b].slotMix[best] ? s : best), SLOTS[0]);
  const confounded =
    present.length >= 2 && modalSlot(present[0]) !== modalSlot(present[present.length - 1]);

  return {
    bands: BANDS.map((b) => stats[b]),
    unbanded,
    otherModel,
    floor: CALIBRATION_FLOOR,
    minGap: CALIBRATION_MIN_GAP,
    verdict,
    confounded,
  };
}

/** Timed-minutes share of one category within [from, to) — NULL-safe: no timed
 *  minutes in the window at all ⇒ null (no data ≠ 0%). */
async function categoryShare(ownerId: string, category: string, fromISO: string, toISO: string): Promise<number | null> {
  const row = await store()
    .prepare(
      `SELECT
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM entity_categories ec
             JOIN tags tg ON tg.id = ec.category_tag_id AND LOWER(tg.name) = LOWER(?)
            WHERE ec.entity_kind = 'task' AND ec.entity_id = e.task_id
         ) THEN mins ELSE 0 END) AS cat_mins,
         SUM(mins) AS all_mins
       FROM (
         SELECT task_id,
                CAST((julianday(ended_at) - julianday(started_at)) * 1440 AS INTEGER) AS mins
           FROM time_entries
          WHERE owner_id = ? AND ended_at IS NOT NULL AND started_at >= ? AND started_at < ?
       ) e`,
    )
    .get<{ cat_mins: number | null; all_mins: number | null }>(category, ownerId, fromISO, toISO);
  if (!row?.all_mins) return null;
  return Math.round(((row.cat_mins ?? 0) / row.all_mins) * 1000) / 1000;
}

export async function trialityMetrics(ownerId: string, now: Date, days = 30): Promise<TrialityMetrics> {
  const windowDays = Math.max(1, Math.min(365, Math.floor(days) || 30));
  const to = now.toISOString();
  const from = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const priorFrom = new Date(now.getTime() - 2 * windowDays * 86_400_000).toISOString();

  const acceptance = Object.fromEntries(
    await Promise.all(SLOTS.map(async (s) => [s, await slotAcceptance(ownerId, s, from, to, now)])),
  ) as Record<Slot, SlotAcceptance>;

  const novelPrior = await slotAcceptance(ownerId, 'novel', priorFrom, from, now);

  // Deficit response: categories the §6 arithmetic currently marks under-served
  // (+1) — read from the ONE source, the vector's cat_deficit dims — with the
  // count of taken Contextual/Novel picks whose action carries the category, and
  // the timed-minutes share this window vs the prior one. Correlation surfaced
  // honestly: the tiles say "moved with", never "because".
  const vector = buildSituationVector(ownerId, now);
  const underServed = Object.entries(vector.dims)
    .filter(([k, v]) => k.startsWith('cat_deficit_') && v === 1)
    .map(([k]) => k.slice('cat_deficit_'.length));

  const takenPicks = await store()
    .prepare(
      `SELECT action_ref FROM triality_log
        WHERE owner_id = ? AND slot IN ('contextual', 'novel')
          AND outcome IN ('staged', 'opened') AND shown_at >= ? AND action_kind IN ('task', 'flight')`,
    )
    .all<{ action_ref: string }>(ownerId, from);

  const deficitResponse = [];
  for (const category of underServed) {
    let count = 0;
    for (const p of takenPicks) {
      const hit = await store()
        .prepare(
          `SELECT 1 FROM entity_categories ec
             JOIN tags tg ON tg.id = ec.category_tag_id AND LOWER(tg.name) = LOWER(?)
            WHERE ec.entity_kind = 'task' AND ec.entity_id = ?`,
        )
        .get(category, p.action_ref);
      if (hit) count++;
    }
    deficitResponse.push({
      category,
      takenPicks: count,
      currentShare: await categoryShare(ownerId, category, from, to),
      priorShare: await categoryShare(ownerId, category, priorFrom, from),
    });
  }

  return {
    windowDays,
    acceptance,
    novelTrend: { current: acceptance.novel.rate, prior: novelPrior.rate },
    deficitResponse,
    weights: await readWeights(ownerId),
    calibration: await bandCalibration(ownerId, from, to, now),
  };
}

/** Null (not []) when the owner has no LEARNED ROWS yet, so the tile can render
 *  "learning hasn't started" rather than an empty table. Migration 0142 always
 *  creates the table, so there is nothing to probe for — absence of rows is the
 *  only "not started" state, and it is also what a reset leaves behind. */
async function readWeights(ownerId: string): Promise<TrialityMetrics['weights']> {
  const rows = await store()
    .prepare(`SELECT slot, weights, sample_count, computed_date FROM triality_weights WHERE owner_id = ?`)
    .all<{ slot: string; weights: string; sample_count: number; computed_date: string }>(ownerId);
  if (rows.length === 0) return null;
  return rows.map((r) => {
    let weights: Record<string, number> = {};
    try { weights = JSON.parse(r.weights); } catch { /* a bad row renders as {} rather than breaking the tab */ }
    return { slot: r.slot, weights, sampleCount: r.sample_count, computedDate: r.computed_date };
  });
}
