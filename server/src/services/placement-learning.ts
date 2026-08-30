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

/** Evidence window; the read-side 90-day windowing itself lands in ticket 4. */
export const PLACEMENT_WINDOW_DAYS = 90;

/**
 * Bounds one row's `candidates` JSON. A day fragmented into more than twelve free gaps
 * has no legible preference left to learn — the slots are noise, not a choice — so the
 * menu is capped rather than grown without limit.
 */
export const MAX_CANDIDATES_LOGGED = 12;

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
