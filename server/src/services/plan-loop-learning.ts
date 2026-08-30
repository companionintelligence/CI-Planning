import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
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
