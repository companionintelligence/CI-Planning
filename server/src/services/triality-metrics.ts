import { sqlite } from '../db/index.js';
import { buildSituationVector } from './triality-vector.js';
import { collapseImpressions } from './triality-learning.js';
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

const PENDING_MS = 24 * 3600_000;

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
}

function slotAcceptance(ownerId: string, slot: Slot, fromISO: string, toISO: string, now: Date): SlotAcceptance {
  const raw = sqlite
    .prepare(
      `SELECT outcome, shown_at, action_ref, local_date FROM triality_log
        WHERE owner_id = ? AND slot = ? AND shown_at >= ? AND shown_at < ?
        ORDER BY id ASC`,
    )
    .all(ownerId, slot, fromISO, toISO) as { outcome: string; shown_at: string; action_ref: string; local_date: string }[];
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

/** Timed-minutes share of one category within [from, to) — NULL-safe: no timed
 *  minutes in the window at all ⇒ null (no data ≠ 0%). */
function categoryShare(ownerId: string, category: string, fromISO: string, toISO: string): number | null {
  const row = sqlite
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
    .get(category, ownerId, fromISO, toISO) as { cat_mins: number | null; all_mins: number | null };
  if (!row.all_mins) return null;
  return Math.round(((row.cat_mins ?? 0) / row.all_mins) * 1000) / 1000;
}

export function trialityMetrics(ownerId: string, now: Date, days = 30): TrialityMetrics {
  const windowDays = Math.max(1, Math.min(365, Math.floor(days) || 30));
  const to = now.toISOString();
  const from = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const priorFrom = new Date(now.getTime() - 2 * windowDays * 86_400_000).toISOString();

  const acceptance = Object.fromEntries(
    SLOTS.map((s) => [s, slotAcceptance(ownerId, s, from, to, now)]),
  ) as Record<Slot, SlotAcceptance>;

  const novelPrior = slotAcceptance(ownerId, 'novel', priorFrom, from, now);

  // Deficit response: categories the §6 arithmetic currently marks under-served
  // (+1) — read from the ONE source, the vector's cat_deficit dims — with the
  // count of taken Contextual/Novel picks whose action carries the category, and
  // the timed-minutes share this window vs the prior one. Correlation surfaced
  // honestly: the tiles say "moved with", never "because".
  const vector = buildSituationVector(ownerId, now);
  const underServed = Object.entries(vector.dims)
    .filter(([k, v]) => k.startsWith('cat_deficit_') && v === 1)
    .map(([k]) => k.slice('cat_deficit_'.length));

  const takenPicks = sqlite
    .prepare(
      `SELECT action_ref FROM triality_log
        WHERE owner_id = ? AND slot IN ('contextual', 'novel')
          AND outcome IN ('staged', 'opened') AND shown_at >= ? AND action_kind IN ('task', 'flight')`,
    )
    .all(ownerId, from) as { action_ref: string }[];

  const deficitResponse = underServed.map((category) => {
    let count = 0;
    for (const p of takenPicks) {
      const hit = sqlite
        .prepare(
          `SELECT 1 FROM entity_categories ec
             JOIN tags tg ON tg.id = ec.category_tag_id AND LOWER(tg.name) = LOWER(?)
            WHERE ec.entity_kind = 'task' AND ec.entity_id = ?`,
        )
        .get(category, p.action_ref);
      if (hit) count++;
    }
    return {
      category,
      takenPicks: count,
      currentShare: categoryShare(ownerId, category, from, to),
      priorShare: categoryShare(ownerId, category, priorFrom, from),
    };
  });

  return {
    windowDays,
    acceptance,
    novelTrend: { current: acceptance.novel.rate, prior: novelPrior.rate },
    deficitResponse,
    weights: readWeights(ownerId),
  };
}

/** Null (not []) when the owner has no LEARNED ROWS yet, so the tile can render
 *  "learning hasn't started" rather than an empty table. Migration 0142 always
 *  creates the table, so there is nothing to probe for — absence of rows is the
 *  only "not started" state, and it is also what a reset leaves behind. */
function readWeights(ownerId: string): TrialityMetrics['weights'] {
  const rows = sqlite
    .prepare(`SELECT slot, weights, sample_count, computed_date FROM triality_weights WHERE owner_id = ?`)
    .all(ownerId) as { slot: string; weights: string; sample_count: number; computed_date: string }[];
  if (rows.length === 0) return null;
  return rows.map((r) => {
    let weights: Record<string, number> = {};
    try { weights = JSON.parse(r.weights); } catch { /* a bad row renders as {} rather than breaking the tab */ }
    return { slot: r.slot, weights, sampleCount: r.sample_count, computedDate: r.computed_date };
  });
}
