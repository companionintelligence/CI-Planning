import { store } from '../db/store.js';
import { localDateInTZ } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { DEFAULT_WEIGHTS, SLOTS, type Slot, type SlotWeights } from './triality.js';

/**
 * Triality T8 — the learning loop (docs/triality-design.md §6b).
 *
 * The `calibrate_estimates` shape, applied to suggestion ranking: a deterministic
 * BATCH pass over durable evidence (`triality_log`) that replaces a regenerable
 * rollup (`triality_weights`). Never online, never mid-request — the engine reads
 * one consistent weight set per run through `getWeights`, and a weight can only
 * change when this job runs.
 *
 * The bounds ARE the contract (§6b): clamped to ±2× / ½× of the §5 defaults,
 * renormalized to the default sum, per-owner, and fully visible in the Balance
 * tiles. They are also the leaky-blanket guard (§2b): they cap how far an error
 * misattributed to the wrong component can bend the model. There is deliberately
 * NO learning-rate pref or env knob — when learning underperforms, the sanctioned
 * response is widening the situation vector's dim registry, never a hotter rate.
 */

// ── Named constants (§6b) — cited by tests and reviewers, not configurable ─────

/** Evidence window, matching the metrics tab's longest and the engine's §5 window. */
export const LEARNING_WINDOW_DAYS = 90;

/** A still-`shown` row younger than this is PENDING — undecided, so it is not
 *  evidence at all. Identical boundary to services/triality-metrics.ts (one line,
 *  drawn once): strictly younger than 24h ⇒ pending; 24h or older ⇒ ignored. */
export const PENDING_MS = 24 * 3_600_000;

/** Decided rows a slot needs before learning touches it. Below it: no row at all,
 *  and absence means "the §5 defaults" by getWeights' contract. */
export const OUTCOME_FLOOR = 20;

/** Reward per decided row. `ignored` is the weak negative: a suggestion the owner
 *  neither opened nor dismissed within a day argued weakly against itself. */
export const REWARDS = { staged: 1, opened: 0.5, dismissed: -1, ignored: -0.25 } as const;

/** How much of a component's covariance with reward reaches its weight. */
export const LEARNING_FACTOR = 0.5;

/** Multiplicative clamp bounds on each weight, relative to its §5 default. */
export const CLAMP_LO = 0.5;
export const CLAMP_HI = 2;

/** Mirrors SlotWeights' keys. Fixed order, because it fixes float summation order
 *  (and the stored JSON's key order) — determinism is asserted, not hoped for. */
const COMPONENTS = ['F', 'H', 'Q', 'N', 'C'] as const;
export type Component = (typeof COMPONENTS)[number];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrialityCalibrationResult {
  /** Decided (non-pending) log rows examined across all slots in the window. */
  outcomeRows: number;
  /** Slots that cleared the floor and got a row. */
  slotsWritten: number;
  /** Slots left on defaults — no row written. */
  slotsFloored: number;
  /** The floor constant, echoed for the job's log line. */
  floor: number;
}

/** One piece of evidence: a reward and whatever component scores survived parsing. */
export interface DecidedRow {
  reward: number;
  scores: Partial<Record<Component, number>>;
}

// ── Evidence reading ──────────────────────────────────────────────────────────

/**
 * The reward map (§6b). `null` means "not evidence": a pending row, an outcome
 * outside the code-enforced enum, or an unparseable `shown_at` (age unknown ⇒ we
 * cannot honestly call it ignored). Null rows are excluded from BOTH the math and
 * the sample count, so a fresh suggestion can never dilute a slot toward its floor.
 */
export function rowReward(outcome: string, shownAt: string, now: Date): number | null {
  if (outcome === 'staged') return REWARDS.staged;
  if (outcome === 'opened') return REWARDS.opened;
  if (outcome === 'dismissed') return REWARDS.dismissed;
  if (outcome !== 'shown') return null;
  const shownMs = Date.parse(shownAt);
  if (!Number.isFinite(shownMs)) return null;
  return now.getTime() - shownMs < PENDING_MS ? null : REWARDS.ignored;
}

/**
 * The per-pick score breakdown the log persists is the whole reason learning is
 * possible (§7). A component that is missing or non-numeric is ABSENT, never
 * coerced to 0: 0 is a real score ("no context fit at all") and inventing it would
 * drag that component's mean toward zero and manufacture covariance out of a
 * corrupt row. Absent means the row simply does not vote on that component —
 * every other component in the same row still counts.
 */
function parseScores(json: string): Partial<Record<Component, number>> {
  const out: Partial<Record<Component, number>> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out; // a corrupt row is silent evidence-of-nothing, never a job failure
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const rec = parsed as Record<string, unknown>;
  for (const k of COMPONENTS) {
    const v = rec[k];
    // OUT OF [0,1] IS ABSENT, not clamped — and this is what makes the §6b bound
    // self-enforcing rather than accidental. Every engine component is provably in
    // [0,1] (contextFit, habitStrengths, sequenceFits, capacityScore, noveltyScores
    // all normalize), so a stored score outside it is a corrupt or hand-edited row,
    // not a score. Rejecting it here caps |delta_k| at 0.5 by construction — which
    // is precisely why the multiplicative clamp can never bind on real evidence —
    // and it closes the only path by which a pathological magnitude (1e308 → mean
    // overflow → NaN) could reach the update rule at all.
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out[k] = v;
  }
  return out;
}

// ── The update rule (§6b) ─────────────────────────────────────────────────────

/**
 * `delta_k` = mean over the slot's decided rows of `reward · (s_k − mean(s_k))` —
 * the covariance between reward and the component's deviation from its own mean.
 *
 * Two consequences worth knowing before reading a test: rows where `s_k` is absent
 * are excluded from the mean AND from the average (the denominator is the count of
 * rows that actually carry `s_k`), and a slot whose rewards are all IDENTICAL
 * yields delta exactly 0 for every component — deviations from the mean sum to
 * zero, so uniform feedback carries no information about which component earned
 * it. Learning here is about co-variation, not about volume of praise or blame.
 */
export function componentDeltas(rows: DecidedRow[]): Record<Component, number> {
  const deltas = {} as Record<Component, number>;
  for (const k of COMPONENTS) {
    const present = rows.filter((r) => r.scores[k] !== undefined);
    if (present.length === 0) {
      deltas[k] = 0;
      continue;
    }
    const mean = present.reduce((s, r) => s + (r.scores[k] as number), 0) / present.length;
    deltas[k] =
      present.reduce((s, r) => s + r.reward * ((r.scores[k] as number) - mean), 0) / present.length;
  }
  return deltas;
}

/**
 * `w_k = clamp(default_k · (1 + 0.5·delta_k), 0.5·default_k, 2·default_k)`, then
 * renormalized so the slot's weights sum to its DEFAULT sum — learning changes
 * emphasis, never total magnitude (which is also why "every weight at 2×" is not a
 * reachable state: the renormalization would divide it straight back to defaults).
 *
 * Because each bound is a MULTIPLE of the default, a component whose default is 0
 * stays 0 forever: habitual's N and C, contextual's Q and C (§5). That is
 * intended, not an oversight — learning tunes emphasis WITHIN a slot's character
 * and can never change that character, so the Habitual slot can never become
 * novelty-seeking no matter what the log says.
 *
 * Returns `null` when the clamped weights sum to 0 (nothing to normalize against);
 * the caller writes nothing for that slot and the defaults stand.
 */
export function applyUpdateRule(
  slot: Slot,
  deltas: Record<Component, number>,
): { clamped: SlotWeights; weights: SlotWeights } | null {
  const defaults = DEFAULT_WEIGHTS[slot];
  const clamped = {} as SlotWeights;
  let sum = 0;
  let defaultSum = 0;
  for (const k of COMPONENTS) {
    const d = defaults[k];
    const raw = d * (1 + LEARNING_FACTOR * deltas[k]);
    clamped[k] = Math.min(CLAMP_HI * d, Math.max(CLAMP_LO * d, raw));
    sum += clamped[k];
    defaultSum += d;
  }
  if (!(sum > 0)) return null;
  const factor = defaultSum / sum;
  const weights = {} as SlotWeights;
  for (const k of COMPONENTS) weights[k] = clamped[k] * factor;
  return { clamped, weights };
}

// ── Persistence ───────────────────────────────────────────────────────────────

// ORDER BY id: uuid7 ids are time-ordered, so this fixes the row order and thus
// the float summation order — the same log must produce bit-identical weights.
// SQL at module level, prepared inside calibrateTriality — a module-level store()
// call would throw when this module loads before db/index installs the backend.
const SELECT_WINDOW_SQL =
  `SELECT slot, outcome, shown_at, scores, action_ref, local_date FROM triality_log
    WHERE owner_id = ? AND shown_at >= ? AND shown_at <= ?
    ORDER BY id ASC`;

/**
 * Collapse IMPRESSIONS into DECISIONS — one vote per (slot, action, owner-local day).
 *
 * This is load-bearing, not tidying. `triality_log` is an impression log: every
 * GET /api/triality/next appends three fresh rows (a shown suggestion is an event,
 * by design), and the Focus banner refetches on each mount — so simply revisiting
 * the view manufactures duplicate rows for the same suggestion on the same day.
 * Counting those raw would let UI navigation outvote the owner: enough untouched
 * re-renders of one pick can invert the sign of a component's learned weight, and
 * could even clear OUTCOME_FLOOR on their own, so the metrics tile would claim
 * "learned from 20 samples" for an owner who never gave a single one.
 *
 * The collapse rule: a decision beats an impression (any non-`shown` row in the
 * group wins, earliest by id if several), otherwise the group's EARLIEST `shown`
 * row represents it — so the group is judged pending-vs-ignored by how long the
 * owner has actually had the suggestion in front of them, not by the most recent
 * remount. Grouping preserves id order, keeping float summation bit-identical.
 */
export function collapseImpressions<T extends { id?: string; slot: string; outcome: string; shown_at: string; scores: string; action_ref: string; local_date: string }>(
  rows: readonly T[],
): T[] {
  const best = new Map<string, T>();
  // "Decided" means decided WITH A KNOWN OUTCOME. An off-enum outcome (a future
  // 'snoozed', a hand-edited row) must not represent a group: rowReward returns
  // null for it downstream, so the group's REAL evidence — a staged row it
  // displaced — would be silently destroyed. Uninterpretable rows are skipped
  // entirely; adding a fourth outcome later degrades to "not evidence yet"
  // instead of to evidence deletion.
  const KNOWN_DECIDED = new Set(['staged', 'opened', 'dismissed']);
  for (const r of rows) {
    if (r.outcome !== 'shown' && !KNOWN_DECIDED.has(r.outcome)) continue;
    const key = `${r.slot}\u0000${r.action_ref}\u0000${r.local_date}`;
    const held = best.get(key);
    if (!held) { best.set(key, r); continue; }
    const heldDecided = KNOWN_DECIDED.has(held.outcome);
    const rowDecided = KNOWN_DECIDED.has(r.outcome);
    if (rowDecided && !heldDecided) { best.set(key, r); continue; }
    // Between two impressions, the EARLIEST-SHOWN represents the group — compared
    // on shown_at explicitly, never assumed from id order: uuid7 ids minted in
    // the same millisecond carry random low bits, so id order is only ms-granular
    // and the "earliest" contract must not hinge on it.
    if (!rowDecided && !heldDecided && r.shown_at < held.shown_at) best.set(key, r);
  }
  return [...best.values()];
}

const DELETE_WEIGHTS_SQL = `DELETE FROM triality_weights WHERE owner_id = ?`;

const INSERT_WEIGHTS_SQL =
  `INSERT INTO triality_weights (owner_id, slot, weights, sample_count, computed_date)
   VALUES (?, ?, ?, ?, ?)`;

/**
 * Recompute this owner's learned slot weights from the last 90 days of outcomes.
 *
 * Wholesale replacement (the calibrate_estimates delete-then-insert): the DELETE is
 * load-bearing, not tidiness. A slot whose sample SHRANK below the floor — rows
 * aged out of the window, or a `triality_log` the owner reset — must lose its row,
 * or scoring would keep serving weights learned from evidence that no longer
 * qualifies. Absence is the only honest representation of "back on defaults".
 *
 * The Triality flag is deliberately not re-checked here: with the flag off nothing
 * writes `triality_log`, so this is already a no-op, and re-deriving from an
 * existing log after the flag comes back on is the correct behavior. Clearing
 * learned weights is a separate, explicit owner action (the reset switch, §6b).
 */
export async function calibrateTriality(ownerId: string, now: Date): Promise<TrialityCalibrationResult> {
  const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString();
  const raw = await store().prepare(SELECT_WINDOW_SQL).all<{
    slot: string;
    outcome: string;
    shown_at: string;
    scores: string;
    action_ref: string;
    local_date: string;
  }>(ownerId, since, now.toISOString());
  // One vote per suggestion per day — see collapseImpressions. Without this the
  // learning corpus counts UI remounts as evidence.
  const rows = collapseImpressions(raw);

  const bySlot = new Map<Slot, DecidedRow[]>(SLOTS.map((s) => [s, []]));
  let outcomeRows = 0;
  for (const r of rows) {
    // `slot` is a code-enforced enum (no CHECK constraint): an unknown value is a
    // row this version cannot interpret, so it is not evidence for any slot.
    const bucket = bySlot.get(r.slot as Slot);
    if (!bucket) continue;
    const reward = rowReward(r.outcome, r.shown_at, now);
    if (reward === null) continue;
    outcomeRows++;
    bucket.push({ reward, scores: parseScores(r.scores) });
  }

  const writes: Array<{ slot: Slot; weights: SlotWeights; sampleCount: number }> = [];
  let slotsFloored = 0;
  for (const slot of SLOTS) {
    const decided = bySlot.get(slot) as DecidedRow[];
    if (decided.length < OUTCOME_FLOOR) {
      slotsFloored++;
      continue;
    }
    const applied = applyUpdateRule(slot, componentDeltas(decided));
    if (!applied) {
      slotsFloored++; // degenerate all-zero slot: treated exactly like a floored one
      continue;
    }
    writes.push({ slot, weights: applied.weights, sampleCount: decided.length });
  }

  const computedDate = localDateInTZ(now.toISOString(), ownerTimezone(ownerId));
  await store().transaction(async () => {
    await store().prepare(DELETE_WEIGHTS_SQL).run(ownerId);
    const insertWeights = store().prepare(INSERT_WEIGHTS_SQL);
    for (const w of writes) {
      // COMPONENTS order in, COMPONENTS order out: a stable JSON string is what
      // makes "same log ⇒ same row" checkable byte-for-byte.
      await insertWeights.run(ownerId, w.slot, JSON.stringify(w.weights), w.sampleCount, computedDate);
    }
  });

  return { outcomeRows, slotsWritten: writes.length, slotsFloored, floor: OUTCOME_FLOOR };
}
