import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { localDateInTZ, utcToZonedWallTime } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { logger } from '../lib/logger.js';
import { taskNestCoords } from './auto-nest.js';

/**
 * Placement capture — the write half of the scheduler-learns-from-corrections loop.
 *
 * Same contract as services/classification-learning.ts: durable, append-only evidence
 * (`placement_log`, landed by ticket 1) opened the instant the Auto engine chooses a
 * slot. This ticket only OPENS a row — `logPlacement` writes `moved_*` and `moved_at`
 * as NULL; ticket 3 closes the row when the owner corrects the placement, the same way
 * `recordCorrection` closes a `classification_log` row.
 *
 * `logPlacement` is called from exactly one place: the Auto placement loop
 * (`engine/autoplan.ts`, `placeIntoWindow`), right after each successful
 * `INSERT INTO time_blocks`. Pattern and container placements
 * (`engine/patterns-place.ts`, `engine/blocks-place.ts`) and the stated-time path
 * (`autoplan.ts`'s start-anchored insert) do not call this — the scheduler made no
 * choice on those paths, so there is nothing to learn.
 *
 * Never throws, never reads `placement_log` or `placement_preferences`, never biases a
 * placement: this ticket is capture only. A dropped `placement_log` table logs a
 * warning and the placement still lands — losing one example out of a 90-day window
 * costs far less than failing a placement.
 */

// ── Named constants — cited by tests and reviewers, not configurable ──────────

/** Evidence window for both the batch read below and, eventually, the apply side —
 *  matches classification-learning's `LEARNING_WINDOW_DAYS`. */
export const PLACEMENT_WINDOW_DAYS = 90;

/**
 * Bounds one row's `candidates` JSON. A day fragmented into more than twelve free gaps
 * has no legible preference left to learn — the slots are noise, not a choice — so the
 * menu is capped rather than grown without limit.
 */
export const MAX_CANDIDATES_LOGGED = 12;

/**
 * Corrected rows a key needs before `calibratePlacement` writes it a preference row.
 * Above classification's `CORRECTION_FLOOR` of 2: a drag is one gesture with many
 * possible meanings (a resize, a nudge to make room, a genuine time-of-day
 * disagreement), and a worse schedule is more disruptive to live with than a wrong tag
 * is to relabel — so the bar to start biasing placement is higher.
 */
export const CORRECTION_FLOOR = 5;

/** Preference rows kept per owner, highest `sample_count` first. Bounds the table and
 *  keeps the batch's write cost flat no matter how many direction tags an owner has. */
export const MAX_PREFERENCE_KEYS = 50;

/**
 * A band wider than this many hours is "any time", not a preference — biasing gap
 * choice on a six-hour-plus spread would buy fragmentation for noise. It also fences
 * the midnight-wrap case, where linear percentiles over hours are meaningless.
 */
export const MAX_BAND_HOURS = 6;

/** Window for the one `placement_survival` reading a run produces — narrower than
 *  `PLACEMENT_WINDOW_DAYS` so the survival trend reacts to the owner's last month, not
 *  their last quarter. A recorded parameter of the reading, not a tunable. */
export const SURVIVAL_PERIOD_DAYS = 28;

// ── SQL (module level, prepared inside the function — §5.5) ───────────────────

const INSERT_LOG = `
  INSERT INTO placement_log
    (id, owner_id, block_id, task_id, slot_key, auto_run_id,
     chosen_start_at, chosen_end_at, chosen_hour, fit, candidates, placed_at, local_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** One free gap the scheduler weighed, as snapshotted immediately before `pickGap`. */
export interface CandidateGap {
  /** Gap start, epoch ms. */
  s: number;
  /** Gap end, epoch ms. */
  e: number;
  /** Gap cursor at snapshot time, epoch ms. */
  c: number;
}

export interface LogPlacementInput {
  blockId: string;
  taskId: string;
  slotKey: string;
  autoRunId: string | null;
  chosenStartAt: string;
  chosenEndAt: string;
  /** `1` when `pickGap` found a gap that fully fit; `0` when it fell back and truncated. */
  fit: 0 | 1;
  /** The gap menu, snapshotted in day order before the pick; capped here. */
  candidates: readonly CandidateGap[];
}

/**
 * Resolve one task's `slot_key`: the level-1 direction tag name sorted first, or the
 * literal `'(none)'` for an untagged task. Backed by a per-run `Map` the caller owns,
 * so a run placing N tasks issues at most N coordinate reads — once per task, never
 * once per session — no matter how many sessions a task splits into.
 */
export async function slotKeyFor(
  ownerId: string,
  taskId: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(taskId);
  if (cached !== undefined) return cached;
  const coords = await taskNestCoords(ownerId, taskId);
  const key = [...coords.directions].sort()[0] ?? '(none)';
  cache.set(taskId, key);
  return key;
}

/**
 * Record that the Auto engine placed `input.blockId` at `input.chosenStartAt` /
 * `input.chosenEndAt`, having weighed `input.candidates`. Called AFTER the
 * `time_blocks` insert lands, so the log never claims a placement the insert rejected.
 *
 * Never throws: a placement that succeeded must not be reported as failed because the
 * learning log had a bad day.
 */
export async function logPlacement(
  ownerId: string,
  input: LogPlacementInput,
  now: Date = new Date(),
): Promise<void> {
  try {
    const tz = await ownerTimezone(ownerId);
    const wall = utcToZonedWallTime(input.chosenStartAt, tz);
    const chosenHour = Number(wall.slice(0, 2));
    const candidates = input.candidates.slice(0, MAX_CANDIDATES_LOGGED);
    await store().prepare(INSERT_LOG).run(
      newId(), ownerId, input.blockId, input.taskId, input.slotKey, input.autoRunId,
      input.chosenStartAt, input.chosenEndAt, chosenHour, input.fit, JSON.stringify(candidates),
      now.toISOString(), localDateInTZ(now.toISOString(), tz),
    );
  } catch (err) {
    logger.warn('placement-learning: could not log placement', { err: (err as Error).message });
  }
}

/**
 * The still-open placement_log row for a block, newest first. Owner-scoped even though
 * `block_id` is already unique — defence in depth, matching `SELECT_OPEN_ASSIGNMENT`.
 * `ORDER BY ..., id DESC` because uuid7 ties are random within a millisecond, so
 * `placed_at` alone is not a total order.
 */
const SELECT_OPEN_PLACEMENT = `
  SELECT id, chosen_start_at, chosen_end_at FROM placement_log
   WHERE block_id = ? AND owner_id = ? AND moved_at IS NULL
   ORDER BY placed_at DESC, id DESC LIMIT 1`;

/** `moved_at IS NULL` in the WHERE makes the settle-once rule atomic rather than a
 *  read-then-write race — a second close on the same row is a no-op by construction. */
const CLOSE_PLACEMENT = `
  UPDATE placement_log SET moved_start_at = ?, moved_end_at = ?, moved_hour = ?, moved_at = ?
   WHERE id = ? AND moved_at IS NULL`;

/**
 * Close the open `placement_log` row for a block with where the owner actually put it —
 * the other half of capture: `logPlacement` (ticket 2) records what the scheduler chose
 * and passed over; this records the owner's answer. Called from `updateBlock` whenever a
 * PATCH touches `start_at` or `end_at`.
 *
 * A no-op ("nothing to settle") when: the block has no open row (manually created,
 * pattern-placed, pre-dating this wave, or already settled by an earlier move), or the
 * new times equal the row's `chosen_start_at`/`chosen_end_at` — the owner touched the
 * block and left it where the scheduler put it, which is not a decision, so the row
 * stays open and can still settle as an acceptance later.
 *
 * Never throws, for the same reason as `logPlacement`: a block edit that succeeded must
 * not be reported as failed because the learning log had a bad day. Returns whether a
 * row was closed, for tests and callers that want to know, the same as
 * `recordCorrection` does.
 */
export async function recordPlacementMove(
  ownerId: string,
  blockId: string,
  startAt: string,
  endAt: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const open = await store().prepare(SELECT_OPEN_PLACEMENT)
      .get<{ id: string; chosen_start_at: string; chosen_end_at: string }>(blockId, ownerId);
    if (!open) return false;
    if (startAt === open.chosen_start_at && endAt === open.chosen_end_at) return false;
    const tz = await ownerTimezone(ownerId);
    const movedHour = Number(utcToZonedWallTime(startAt, tz).slice(0, 2));
    const r = await store().prepare(CLOSE_PLACEMENT).run(startAt, endAt, movedHour, now.toISOString(), open.id);
    return r.changes > 0;
  } catch (err) {
    logger.warn('placement-learning: could not record move', { err: (err as Error).message });
    return false;
  }
}

// ── Calibration: the batch pass ────────────────────────────────────────────────

/** The columns `placementOutcome` grades on — one row of `SELECT_WINDOW` below, or a
 *  hand-built fixture in a test. */
export interface PlacementLogRow {
  fit: number;
  moved_at: string | null;
  moved_hour: number | null;
  chosen_hour: number;
  chosen_start_at: string;
}

/**
 * What one `placement_log` row is worth, or `null` for "not evidence".
 *
 * `fit = 0` is a truncated fallback — `pickGap` ran out of room and forced the block
 * in, so nothing was chosen and there is nothing to learn. Moved rows resolve on
 * whether the destination hour differs from what the scheduler chose: a different hour
 * is a disagreement, the same hour (a nudge, or a resize) is the twin of
 * classification's "corrected to the same value is an acceptance". An untouched row
 * resolves on the block and the clock: `reflow()` deletes and recreates auto blocks
 * constantly, so a vanished block was never lived with and is pending forever, not
 * accepted; a slot that has not arrived yet is genuinely undecided; one that has
 * already passed means the owner lived with it.
 */
export function placementOutcome(
  row: PlacementLogRow,
  now: Date,
  blockExists: boolean,
): 'corrected' | 'accepted' | null {
  if (row.fit === 0) return null;
  if (row.moved_at) return row.moved_hour !== row.chosen_hour ? 'corrected' : 'accepted';
  if (!blockExists) return null;
  return Date.parse(row.chosen_start_at) < now.getTime() ? 'accepted' : null;
}

interface WindowRow extends PlacementLogRow {
  slot_key: string;
  local_date: string;
  block_exists: 0 | 1;
}

/**
 * One owner's `placement_log` rows inside the learning window, with the block-existence
 * check folded in as a `LEFT JOIN` — one query, not N. Not a foreign-key join (0166):
 * the log deliberately outlives both `time_blocks` and `tasks`, so this is the only
 * honest way to ask "does the block this row named still exist". Total order —
 * `(local_date, id)`, never `local_date` alone — because uuid7 ties are random within a
 * millisecond.
 */
const SELECT_WINDOW = `
  SELECT pl.slot_key, pl.local_date, pl.fit, pl.chosen_start_at, pl.chosen_hour,
         pl.moved_at, pl.moved_hour,
         CASE WHEN tb.id IS NOT NULL THEN 1 ELSE 0 END AS block_exists
    FROM placement_log pl
    LEFT JOIN time_blocks tb ON tb.id = pl.block_id AND tb.owner_id = pl.owner_id
   WHERE pl.owner_id = ? AND pl.local_date >= ?
   ORDER BY pl.local_date, pl.id`;

/** The same index-quantile Phase N used (0083) — kept so placement bands stay
 *  comparable with estimate bands. Copied rather than exported (services/calibration.ts
 *  `quantile` is module-private by the same convention): a change there touches the
 *  estimate loop, which is out of scope here. */
function hourQuantile(sorted: number[], frac: number): number {
  const n = sorted.length;
  const idx = Math.min(Math.max(0, Math.round(frac * (n - 1))), n - 1);
  return sorted[idx];
}

const DELETE_PREFERENCES = `DELETE FROM placement_preferences WHERE owner_id = ?`;
const INSERT_PREFERENCE = `
  INSERT INTO placement_preferences
    (owner_id, slot_key, p25_hour, p50_hour, p75_hour, corrections, sample_count, computed_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** `(owner_id, computed_date)` is the table's PK (0166): a manual re-run or a cron
 *  retry on the same owner-local day overwrites today's reading rather than stacking a
 *  second one. */
const UPSERT_SURVIVAL = `
  INSERT INTO placement_survival
    (owner_id, computed_date, period_days, decided, accepted, corrected, survival_rate, keys_learned, biased)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (owner_id, computed_date) DO UPDATE SET
    period_days   = excluded.period_days,
    decided       = excluded.decided,
    accepted      = excluded.accepted,
    corrected     = excluded.corrected,
    survival_rate = excluded.survival_rate,
    keys_learned  = excluded.keys_learned,
    biased        = excluded.biased`;

/** One `slot_key`'s band, or the reasons it did not get one this run. */
export interface PlacementKeyResult {
  slotKey: string;
  /** Decided rows (corrected + accepted) inside the window — `sample_count`. */
  decided: number;
  /** Corrected rows among them — what `CORRECTION_FLOOR` gates on. */
  corrections: number;
  p25: number;
  p50: number;
  p75: number;
  /** Whether this key actually got a `placement_preferences` row this run. */
  written: boolean;
}

export interface PlacementSurvivalResult {
  decided: number;
  accepted: number;
  corrected: number;
  survivalRate: number | null;
  keysLearned: number;
  biased: 0 | 1;
}

export interface CalibratePlacementResult {
  keys: PlacementKeyResult[];
  floor: number;
  survival: PlacementSurvivalResult;
}

/**
 * The deterministic BATCH pass. Reads `placement_log` for one owner, grades every row,
 * rebuilds `placement_preferences` wholesale, and records one `placement_survival`
 * reading. Same rows plus the same clock always produce the same output.
 *
 * The band is built from RESTING hours, not correction destinations: a row's resting
 * hour is `moved_hour` when corrected and `chosen_hour` when accepted — where this kind
 * of work actually ends up. Corrections-only would let a handful of evening moves
 * outweigh a couple hundred untouched morning placements and bias everything to the
 * evening; `CORRECTION_FLOOR` still gates whether a key is learned at all, since with no
 * corrections there is nothing to learn and the band would only echo the scheduler's
 * own defaults back at it.
 *
 * Never reads `placement_preferences` (ticket 5 owns the apply stage), never touches
 * Ollama or any model (pure SQL and arithmetic), and never writes `time_blocks` or
 * `tasks` — this function only ever writes `placement_preferences` and
 * `placement_survival`.
 */
export async function calibratePlacement(
  ownerId: string,
  now: Date = new Date(),
): Promise<CalibratePlacementResult> {
  const tz = await ownerTimezone(ownerId);
  const computedDate = localDateInTZ(now.toISOString(), tz);
  const since = localDateInTZ(new Date(now.getTime() - PLACEMENT_WINDOW_DAYS * 86_400_000).toISOString(), tz);
  const survivalSince = localDateInTZ(new Date(now.getTime() - SURVIVAL_PERIOD_DAYS * 86_400_000).toISOString(), tz);

  const rows = await store().prepare(SELECT_WINDOW).all<WindowRow>(ownerId, since);

  const byKey = new Map<string, { hours: number[]; corrections: number }>();
  let survivalDecided = 0;
  let survivalAccepted = 0;
  let survivalCorrected = 0;

  for (const r of rows) {
    const outcome = placementOutcome(r, now, r.block_exists === 1);
    if (outcome === null) continue;
    const restingHour = outcome === 'corrected' ? r.moved_hour! : r.chosen_hour;

    let agg = byKey.get(r.slot_key);
    if (!agg) {
      agg = { hours: [], corrections: 0 };
      byKey.set(r.slot_key, agg);
    }
    agg.hours.push(restingHour);
    if (outcome === 'corrected') agg.corrections++;

    if (r.local_date >= survivalSince) {
      survivalDecided++;
      if (outcome === 'corrected') survivalCorrected++;
      else survivalAccepted++;
    }
  }

  // Total order: sample_count (decided) descending, then slot_key ascending — the same
  // order the cap below applies in, so which keys survive it is never a coin flip.
  const keys: PlacementKeyResult[] = [...byKey.entries()]
    .map(([slotKey, agg]) => {
      const sorted = [...agg.hours].sort((a, b) => a - b);
      return {
        slotKey,
        decided: agg.hours.length,
        corrections: agg.corrections,
        p25: hourQuantile(sorted, 0.25),
        p50: hourQuantile(sorted, 0.5),
        p75: hourQuantile(sorted, 0.75),
        written: false,
      };
    })
    .sort((a, b) => b.decided - a.decided || a.slotKey.localeCompare(b.slotKey));

  let writtenCount = 0;
  for (const k of keys) {
    const eligible = k.corrections >= CORRECTION_FLOOR && k.p75 - k.p25 <= MAX_BAND_HOURS;
    k.written = eligible && writtenCount < MAX_PREFERENCE_KEYS;
    if (k.written) writtenCount++;
  }

  // `biased` records whether the owner already had a rollup BEFORE this run's wholesale
  // replace — read the count first, or the DELETE below would always answer "no".
  const prior = await store()
    .prepare(`SELECT COUNT(*) AS n FROM placement_preferences WHERE owner_id = ?`)
    .get<{ n: number }>(ownerId);
  const biased: 0 | 1 = (prior?.n ?? 0) > 0 ? 1 : 0;

  const survivalRate = survivalDecided > 0 ? survivalAccepted / survivalDecided : null;

  // Wholesale replacement, atomically (the calibrate_estimates / calibrate_triality /
  // calibrate_classification delete-then-insert). The DELETE is load-bearing: a key
  // that aged out of the window must STOP biasing, and absence is the only honest
  // representation of "back to the stock scheduler". The survival upsert rides in the
  // same transaction, the calibrate_estimates precedent for a rollup and its dated
  // reading: the two must never disagree.
  await store().transaction(async () => {
    await store().prepare(DELETE_PREFERENCES).run(ownerId);
    const ins = store().prepare(INSERT_PREFERENCE);
    for (const k of keys) {
      if (!k.written) continue;
      await ins.run(ownerId, k.slotKey, k.p25, k.p50, k.p75, k.corrections, k.decided, computedDate);
    }
    await store().prepare(UPSERT_SURVIVAL).run(
      ownerId, computedDate, SURVIVAL_PERIOD_DAYS,
      survivalDecided, survivalAccepted, survivalCorrected, survivalRate, writtenCount, biased,
    );
  });

  return {
    keys,
    floor: CORRECTION_FLOOR,
    survival: {
      decided: survivalDecided, accepted: survivalAccepted, corrected: survivalCorrected,
      survivalRate, keysLearned: writtenCount, biased,
    },
  };
}
