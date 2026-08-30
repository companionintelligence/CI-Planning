import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { localDateInTZ } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { auditRecord } from '../agents/loop.js';
import type { LoopResult, Revision } from '../agents/loop.js';

/**
 * Phase M §A0 authoring loop — the durable evidence sink `agents/loop.ts` never got.
 *
 * Same house contract as `services/classification-learning.ts`: durable evidence,
 * a deterministic BATCH pass (ticket 3, not here), a bounded read (ticket 4, not
 * here). **Never online, never mid-request** — this module only ever INSERTs, from
 * exactly the two points in the loop's lifecycle (per-iteration, and once at the
 * end) that already exist. There is no learning-rate knob and never will be: this
 * wave's terminus is a human reading a trend, not anything that changes what the
 * loop does next.
 *
 * The audit trail is UNCHANGED ON PURPOSE. `agents/loop.ts`'s default `record` sink
 * (`auditRecord`) still writes the exact same compact `plan_revision` row to
 * `audit_log` it always has — same shape, same 4000-char cap, same fire-and-forget
 * posture. `recordPlanRevision` below calls that same function directly, so the
 * audit write happens from exactly one code path, whether or not this service is
 * wired in. This module only ADDS the two evidence tables; it never reads, mutates,
 * or reshapes `audit_log`.
 *
 * Every insert here is fire-and-forget and swallows its own failure, matching
 * `lib/audit.ts`'s `writeAudit`: a DB hiccup while recording evidence must never
 * throw into the plan-authoring path, and must never be awaited by a caller (that
 * would make the request wait on evidence nobody reads synchronously).
 * {@link flushPlanLoopWrites} exists solely so tests can await durability before
 * asserting — production code never calls it.
 */

// ── Named constants — cited by tests and reviewers, not configurable ──────────

/** Trailing window the weekly `calibrate_plan_loop` batch pass measures, in days.
 *  Cited by `plan-loop-calibrate.test.ts` and the 0163 cron seed's doc comment.
 *  No env var, no preference — same "no learning-rate knob" rule as
 *  classification-learning's `CORRECTION_FLOOR`/`MAX_EXEMPLARS`. */
export const STATS_WINDOW_DAYS = 7;

/** In-flight evidence writes, so {@link flushPlanLoopWrites} can wait for them. */
const inFlight = new Set<Promise<void>>();

/**
 * Record one loop iteration: one `plan_revision_log` row (the evidence) AND the
 * unchanged `audit_log` row via the re-exported `auditRecord` (loop.ts's own
 * default sink), so the audit trail keeps being written from exactly the same code
 * path as before this service existed.
 */
export function recordPlanRevision(runId: string, ownerId: string, stage: string, rev: Revision): void {
  auditRecord(ownerId, stage, rev);

  const c = JSON.stringify(rev.candidate);
  const candidate = c.length > 8000 ? null : c; // NULL over truncation — a sliced JSON string is invalid JSON
  const p: Promise<void> = store()
    .prepare(
      `INSERT INTO plan_revision_log (id, owner_id, run_id, stage, iter, score, reason, defects, critique, candidate, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      ownerId,
      runId,
      stage,
      rev.iter,
      rev.score,
      rev.reason,
      JSON.stringify(rev.defects.map((d) => d.rule)),
      rev.critique.slice(0, 1000),
      candidate,
      new Date().toISOString(),
    )
    .then(
      () => {},
      () => {}, // silent — evidence must never break the authoring path
    )
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
}

/** Record the outcome of one completed `runLoop()` invocation: one `plan_loop_runs` row. */
export function recordPlanRun(
  runId: string,
  ownerId: string,
  stage: string,
  result: LoopResult<unknown>,
  escapeReason: string | null,
): void {
  const p: Promise<void> = store()
    .prepare(
      `INSERT INTO plan_loop_runs (id, owner_id, stage, passed, escaped, escape_reason, score, iterations, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      ownerId,
      stage,
      result.passed ? 1 : 0,
      result.escaped ? 1 : 0,
      escapeReason,
      result.score,
      result.iterations,
      new Date().toISOString(),
    )
    .then(
      () => {},
      () => {}, // silent — evidence must never break the authoring path
    )
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
}

/**
 * Wait for every evidence write issued so far. Tests only — production code never
 * calls this, exactly like `flushAudits`. Loops rather than draining once, because
 * awaiting the current set can itself let a queued write start (e.g. a run's
 * `plan_loop_runs` insert issued while a prior revision's insert is still
 * in-flight) — a single drain would leave anything issued during the await still
 * outstanding.
 */
export async function flushPlanLoopWrites(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}

// ── Calibration: the batch pass (ticket 3) ─────────────────────────────────────

/** One measured stage for one owner's trailing {@link STATS_WINDOW_DAYS}. */
export interface PlanLoopCalibrationResult {
  stages: {
    stage: string;
    runs: number;
    passed: number;
    escaped: number;
    firstTryPass: number;
    avgIterations: number | null;
    passRate: number | null;
  }[];
}

/**
 * Roll one owner's trailing {@link STATS_WINDOW_DAYS} of `plan_loop_runs` into one
 * `plan_loop_stats` row per stage present in the window. Pure SQL aggregation over
 * evidence already paid for — no Ollama, no `audit_log` read, no adjustment of any
 * loop option from what it measures. Deterministic given the same rows and clock:
 * fixed window, one GROUP BY, no sampling.
 *
 * A stage with zero runs in the window gets no row, in either direction: nothing is
 * read out of it here, and nothing is written for it below — absence is the gap a
 * trend must draw, never a false floor (the `classification_accuracy` rationale
 * ticket 1 cites).
 */
export async function calibratePlanLoop(
  ownerId: string,
  now: Date = new Date(),
): Promise<PlanLoopCalibrationResult> {
  const tz = await ownerTimezone(ownerId);
  const computedDate = localDateInTZ(now.toISOString(), tz);
  const windowStart = new Date(now.getTime() - STATS_WINDOW_DAYS * 86_400_000).toISOString();

  const rows = await store()
    .prepare(
      `SELECT stage, COUNT(*) as runs, SUM(passed) as passed, SUM(escaped) as escaped,
              SUM(CASE WHEN passed = 1 AND iterations = 1 THEN 1 ELSE 0 END) as first_try_pass,
              AVG(iterations) as avg_iterations
         FROM plan_loop_runs
        WHERE owner_id = ? AND at >= ?
        GROUP BY stage`,
    )
    .all<{
      stage: string;
      runs: number;
      passed: number;
      escaped: number;
      first_try_pass: number;
      avg_iterations: number;
    }>(ownerId, windowStart);

  const stages: PlanLoopCalibrationResult['stages'] = [];
  for (const row of rows) {
    const passRate = row.passed / row.runs;
    await store()
      .prepare(
        `INSERT INTO plan_loop_stats
           (owner_id, stage, computed_date, period_days, runs, passed, escaped, first_try_pass, avg_iterations, pass_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, stage, computed_date) DO UPDATE SET
           period_days = excluded.period_days,
           runs = excluded.runs,
           passed = excluded.passed,
           escaped = excluded.escaped,
           first_try_pass = excluded.first_try_pass,
           avg_iterations = excluded.avg_iterations,
           pass_rate = excluded.pass_rate`,
      )
      .run(
        ownerId,
        row.stage,
        computedDate,
        STATS_WINDOW_DAYS,
        row.runs,
        row.passed,
        row.escaped,
        row.first_try_pass,
        row.avg_iterations,
        passRate,
      );

    stages.push({
      stage: row.stage,
      runs: row.runs,
      passed: row.passed,
      escaped: row.escaped,
      firstTryPass: row.first_try_pass,
      avgIterations: row.avg_iterations,
      passRate,
    });
  }

  return { stages };
}

// ── Trend: the read surface (ticket 4) ──────────────────────────────────────

/** The most recent measured `plan_loop_stats` rows per stage — what `routes/plan-loop.ts`
 *  hands the client, mirroring `accuracyTrend` (classification-learning.ts). */
export async function planLoopTrend(
  ownerId: string,
  limit = 26,
): Promise<
  {
    stage: string;
    computed_date: string;
    period_days: number;
    runs: number;
    passed: number;
    escaped: number;
    first_try_pass: number;
    avg_iterations: number | null;
    pass_rate: number | null;
  }[]
> {
  return await store()
    .prepare(
      `SELECT stage, computed_date, period_days, runs, passed, escaped, first_try_pass, avg_iterations, pass_rate
         FROM plan_loop_stats WHERE owner_id = ?
        ORDER BY computed_date DESC, stage LIMIT ?`,
    )
    .all(ownerId, limit);
}
