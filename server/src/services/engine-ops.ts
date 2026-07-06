import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';
import { isValidISODate } from '../lib/dates.js';
import { MAX_SPAN_DAYS } from '../engine/recurrence.js';
import { parseInstruction, authorPlanOrder, type PlanPin, type PlanHint } from '../agents/plan.js';
import {
  placeFlightPlan,
  resolveTrustPolicy,
  type AutoResult,
} from '../engine/autoplan.js';

/**
 * Engine-ops service (Phase W · W13, Decision 3). The scheduling engines themselves
 * (`reflow`/`placeFlightPlan`/`fillByPriority`/`undoLastAuto`/`fillFlightPlanCandidates`/
 * `authorPlanOrder`/`parseInstruction`/`clearPlannerRange`/`resolveTrustPolicy`) ARE the
 * shared core and are NOT reimplemented here. This module extracts ONLY the three pieces
 * of non-trivial INLINE handler logic that a GraphQL resolver would otherwise have to
 * duplicate byte-for-byte from routes/plan.ts, routes/flight-plan.ts, routes/planner.ts:
 *
 *   1. instruct: `applyPins`/`applyHints` (the pin/hint DB writes) + an `instructPlan`
 *      wrapper that parses then applies, so REST + GraphQL share ONE write path.
 *   2. autoRun: the multi-day / trust-policy horizon resolution + placement loop from
 *      POST /api/auto/run.
 *   3. clearPlanner: `validateClearRange` — the 400-check ladder from POST /api/planner/clear,
 *      as a discriminated result so REST maps it to 400 and GraphQL to BAD_USER_INPUT from
 *      ONE source.
 *
 * Convention (matches W5/W10/W11/W12): `writeAudit` lives INSIDE this service so REST and
 * GraphQL emit identical audit rows; the SSE `broadcast(...)` and the snapshot on
 * clearPlanner stay TRANSPORT-side (the route AND the resolver each fire them), since this
 * service is transport-agnostic and returns enough for both to reproduce the side effects.
 *
 * better-sqlite3 is synchronous; the async functions here are async only because they
 * await the engine (parseInstruction / authorPlanOrder).
 */

// ─── 1. instruct (POST /api/plan/instruct) ─────────────────────────────────────

/** Apply parsed time pins as locked, non-auto obstacle blocks the placer routes around. */
function applyPins(owner: string, pins: PlanPin[]): number {
  if (pins.length === 0) return 0;
  const ins = sqlite.prepare(
    `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status)
     VALUES (?, ?, ?, 'meeting', ?, ?, 1, 0, 'instruct', 'planned')`,
  );
  sqlite.transaction(() => { for (const p of pins) ins.run(newId(), owner, p.title, p.start_at, p.end_at); })();
  return pins.length;
}

/**
 * Persist parsed tag hints for (owner, date). They take effect on the next autoplan
 * run: `placeFlightPlan` reads them as transient per-tag day-windows, and
 * `authorPlanOrder` folds them into the ordering prompt. Idempotent (INSERT OR IGNORE
 * against the dedupe index), so a repeated instruct doesn't pile up duplicates.
 */
function applyHints(owner: string, date: string, hints: PlanHint[]): number {
  if (hints.length === 0) return 0;
  const ins = sqlite.prepare(
    `INSERT OR IGNORE INTO plan_hints (id, owner_id, date, kind, tag, time) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  sqlite.transaction(() => { for (const h of hints) ins.run(newId(), owner, date, h.kind, h.tag, h.time ?? null); })();
  return hints.length;
}

export interface InstructOutcome {
  pins: PlanPin[];
  hints: PlanHint[];
  /** Count of pins written (0 if none) — the caller broadcasts `block:created` iff > 0. */
  created: number;
}

/**
 * §A4 — parse a natural-language instruction into a validated constraint set and apply it.
 * Parses BEFORE any write (`parseInstruction` throws `InstructError` on invalid input or
 * Ollama-down), so a rejected instruction never leaves a partial pin/hint behind. On a
 * clean parse: pins become locked obstacle blocks, hints are persisted, and an audit row
 * is written. Re-throws `InstructError` for the transport to map (invalid → 422/BAD_USER_INPUT,
 * unavailable → 503/SERVICE_UNAVAILABLE). The caller broadcasts `block:created` when
 * `created > 0`, so it stays transport-side.
 */
export async function instructPlan(owner: string, date: string, text: string): Promise<InstructOutcome> {
  const result = await parseInstruction(owner, date, text); // validates fully BEFORE any write; throws InstructError
  const created = applyPins(owner, result.pins);
  applyHints(owner, date, result.hints);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'instruct', entity: `plan:${date}` });
  return { pins: result.pins, hints: result.hints, created };
}

// ─── 2. autoRun (POST /api/auto/run) ────────────────────────────────────────────

/** Clamp a planning-horizon day count to a sane 1..60. */
const clampDays = (n: unknown): number => Math.max(1, Math.min(60, Math.floor(Number(n) || 1)));
/** 'YYYY-MM-DD' + n days, computed in UTC (date-only, DST-safe). */
function addDaysISO(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export interface AutoRunInput {
  /** Target local YYYY-MM-DD; caller defaults to localISODate() when omitted. */
  date: string;
  /** Single-Plan placement (always single-day). */
  blockId?: string;
  /** Explicit N-day horizon override (clamped 1..60). */
  horizonDays?: number;
}

/**
 * Resolve the planning horizon (T-SCHED-2) and place the selected staged items.
 *
 * - A specific-block placement (`blockId`) is always single-day.
 * - An explicit `horizonDays` overrides (clamped).
 * - Otherwise Hands-off trust mode spans `scheduling_prefs.planning_horizon_days` (default
 *   7, clamped); Cautious/Balanced stay single-day (byte-identical to before).
 *
 * Multi-day loops the EXISTING single-day placement — no new placement semantics.
 * `authorPlanOrder` authors day 0 normally (LLM when smart) and future days
 * deterministically so a multi-day plan never fires one LLM call per day; `placeFlightPlan`
 * clears each day's prior auto blocks and DELETEs placed tasks from staging, so leftovers
 * fan onto the next day. `silent` suppresses per-day SSE — the caller fires ONE aggregated
 * event. `writeAudit` fires here (per-branch entity, byte-identical to the route); the
 * caller does the `broadcast(...)`.
 */
export async function autoRun(owner: string, input: AutoRunInput): Promise<AutoResult> {
  const { date, blockId, horizonDays } = input;

  const sched = sqlite
    .prepare(`SELECT planning_horizon_days FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as { planning_horizon_days?: number } | undefined;
  const days = blockId != null
    ? 1
    : horizonDays != null
      ? clampDays(horizonDays)
      : (resolveTrustPolicy(owner).mode === 'hands_off' ? clampDays(sched?.planning_horizon_days ?? 7) : 1);

  if (days > 1) {
    let blocksCreated = 0, placed = 0, unplaced = 0;
    for (let d = 0; d < days; d++) {
      const day = addDaysISO(date, d);
      await authorPlanOrder(owner, day, d === 0 ? {} : { deterministic: true });
      const r = placeFlightPlan(owner, { date: day, silent: true });
      blocksCreated += r.blocksCreated ?? 0;
      placed += r.placed ?? 0;
      unplaced = r.unplaced ?? 0; // tasks still staged after the final day
    }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'run', entity: `flight-plan:run:${days}d` });
    return { step: 'place', blocksCreated, placed, unplaced, days };
  }

  await authorPlanOrder(owner, date);
  const result = placeFlightPlan(owner, { blockId, date });
  writeAudit({ ownerId: owner, actor: 'owner', action: 'run', entity: 'flight-plan:run' });
  return result;
}

// ─── 3. validateClearRange (POST /api/planner/clear) ───────────────────────────

export type ClearRangeValidation =
  | { ok: true; start: string; end: string | null; dryRun: boolean }
  | { ok: false; error: string };

/**
 * The 400-check ladder from POST /api/planner/clear, as a discriminated result so REST
 * maps `{ok:false}` to a 400 and GraphQL to BAD_USER_INPUT from ONE source — no logic is
 * duplicated between the transports. Same order + same messages as the original route:
 * start must be YYYY-MM-DD, end (if present) must be YYYY-MM-DD, end >= start, a bounded
 * span must be within MAX_SPAN_DAYS (caps here — a 400 — rather than letting the engine
 * throw a 500), and dry_run must be an explicit boolean if present. Writes nothing.
 */
export function validateClearRange(input: { start?: unknown; end?: unknown; dryRun?: unknown }): ClearRangeValidation {
  const start = input.start;
  const end = input.end === undefined || input.end === null || input.end === '' ? null : input.end;

  if (!isValidISODate(start)) {
    return { ok: false, error: 'start must be a YYYY-MM-DD date' };
  }
  if (end !== null && !isValidISODate(end)) {
    return { ok: false, error: 'end must be a YYYY-MM-DD date' };
  }
  if (end !== null && (end as string) < (start as string)) {
    return { ok: false, error: 'end must be on or after start' };
  }
  if (end !== null) {
    const span = Math.floor((Date.parse(`${end as string}T00:00:00Z`) - Date.parse(`${start as string}T00:00:00Z`)) / 86_400_000);
    if (span > MAX_SPAN_DAYS) {
      return { ok: false, error: `end must be within ${MAX_SPAN_DAYS} days of start` };
    }
  }
  // `dry_run`/`dryRun` must be an explicit boolean if present — otherwise a truthy non-bool
  // (e.g. the string "false") would silently flip an intended apply into a preview.
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    return { ok: false, error: 'dry_run must be a boolean' };
  }

  return { ok: true, start: start as string, end: end as string | null, dryRun: input.dryRun === true };
}
