import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { flushAudits } from '../src/lib/audit.js';
import {
  runLoop,
  type Defect,
  type JudgeScore,
  type LoopOptions,
  type LoopResult,
  type LoopStage,
  type Revision,
} from '../src/agents/loop.js';
import { recordPlanRevision, recordPlanRun, flushPlanLoopWrites } from '../src/services/plan-loop-learning.js';
import { createOwner, resetDb } from './helpers.js';

/**
 * Ticket 2 of the revision-loop wave: `runLoop`'s per-iteration revisions and its
 * final outcome must land as parseable rows in `plan_revision_log` /
 * `plan_loop_runs`, while the pre-existing `plan_revision` audit row keeps being
 * written byte-for-byte identically.
 *
 * Driven exactly like `loop.test.ts` — mock generate/check/judge/revise callbacks,
 * no Ollama, no HTTP server — but wired through the real evidence service instead
 * of a plain in-memory recorder, since what's under test here is the DB write, not
 * the harness contract (that's loop.test.ts's job, and this file must not disturb
 * it: loop.test.ts's own `record` callbacks are untouched by anything here).
 */

type Cand = number[]; // same toy candidate as loop.test.ts: an ordering

interface RunRow {
  id: string;
  owner_id: string;
  stage: string;
  passed: number;
  escaped: number;
  escape_reason: string | null;
  score: number;
  iterations: number;
  at: string;
}

interface RevisionRow {
  id: string;
  owner_id: string;
  run_id: string;
  stage: string;
  iter: number;
  score: number;
  reason: string;
  defects: string;
  critique: string;
  candidate: string | null;
  at: string;
}

/** A stage builder with sensible passing defaults; override per test. */
function baseStage(over: Partial<LoopStage<Cand>> = {}): LoopStage<Cand> {
  return {
    stage: 'order',
    ownerId: SYSTEM_OWNER,
    generate: vi.fn(async () => [0, 1, 2]),
    check: vi.fn(() => [] as Defect[]),
    baseline: vi.fn(() => [99]),
    judge: vi.fn(async (): Promise<JudgeScore> => ({ overall: 0.9, critique: 'fine' })),
    revise: vi.fn(async (c: Cand) => c),
    ...over,
  };
}

/**
 * Mirrors the real `agents/plan.ts` wiring (rev-2's pinned conventions), since this
 * file bypasses `plan.ts` entirely and drives `runLoop` directly: mints a `runId`,
 * wires `record` to `recordPlanRevision` bound to it, captures `escapeReason` off
 * `onEscape` exactly like `plan.ts`'s callback does, then calls `recordPlanRun`
 * itself once `runLoop` returns.
 */
async function runAndRecord(
  stg: LoopStage<Cand>,
  options: Omit<LoopOptions, 'record'> = {},
): Promise<{ runId: string; result: LoopResult<Cand>; escapeReason: string | null }> {
  const runId = newId();
  let escapeReason: string | null = null;
  const userOnEscape = options.onEscape;
  const result = await runLoop(stg, {
    ...options,
    record: (ownerId, stage, rev) => recordPlanRevision(runId, ownerId, stage, rev),
    onEscape: (ownerId, stage, info) => {
      escapeReason = info.reason;
      userOnEscape?.(ownerId, stage, info);
    },
  });
  recordPlanRun(runId, stg.ownerId, stg.stage, result, escapeReason);
  return { runId, result, escapeReason };
}

function runsRow(runId: string): RunRow {
  const row = sqlite.prepare(`SELECT * FROM plan_loop_runs WHERE id = ?`).get(runId) as RunRow | undefined;
  if (!row) throw new Error(`expected a plan_loop_runs row for run ${runId}`);
  return row;
}

function revisionRows(runId: string): RevisionRow[] {
  return sqlite
    .prepare(`SELECT * FROM plan_revision_log WHERE run_id = ? ORDER BY iter`)
    .all(runId) as RevisionRow[];
}

function auditPlanRevisionCount(ownerId: string): number {
  return (
    sqlite
      .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE owner_id = ? AND action = 'plan_revision'`)
      .get(ownerId) as { c: number }
  ).c;
}

beforeEach(() => {
  resetDb();
});

describe('plan-loop-learning — capturing runLoop evidence', () => {
  it('a run that passes on iteration 1 writes one runs row and one revision row', async () => {
    const { runId, result } = await runAndRecord(baseStage());
    await flushPlanLoopWrites();

    expect(result.passed).toBe(true);
    expect(result.iterations).toBe(1);

    const run = runsRow(runId);
    expect(run.passed).toBe(1);
    expect(run.escaped).toBe(0);
    expect(run.escape_reason).toBeNull();
    expect(run.iterations).toBe(1);

    const revs = revisionRows(runId);
    expect(revs).toHaveLength(1);
    expect(revs[0].iter).toBe(1);
    expect(revs[0].reason).toBe('judged');
    expect(revs[0].defects).toBe('[]');
  });

  it('a run that revises then plateaus records escaped=1/plateau, revisions sharing one run_id', async () => {
    // Round 1 scores 0.50, round 2 scores 0.52 (gain 0.02 < epsilon=0.05) => plateau,
    // same fixture as loop.test.ts's plateau case.
    const roundScore = [0.5, 0.52, 0.99];
    let round = 0;
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: roundScore[round] }));
    const revise = vi.fn(async () => {
      round++;
      return [0, 1, 2];
    });

    const { runId, result } = await runAndRecord(baseStage({ judge, revise }), {
      passThreshold: 0.8,
      epsilon: 0.05,
      maxIterations: 3,
    });
    await flushPlanLoopWrites();

    expect(result.escaped).toBe(true);
    expect(result.passed).toBe(false);

    const run = runsRow(runId);
    expect(run.escaped).toBe(1);
    expect(run.escape_reason).toBe('plateau');

    const revs = revisionRows(runId);
    expect(revs.map((r) => r.iter)).toEqual([1, 2]);
    expect(revs.every((r) => r.run_id === runId)).toBe(true);
  });

  it('a deterministic-fail iteration stores score=0, reason=deterministic-fail, and rule codes as JSON', async () => {
    const defects: Defect[] = [
      { rule: 'priority_inversion', detail: 'index 4 (P1) must precede index 2 (P3)' },
      { rule: 'tag_group_split', detail: 'contiguous tag group broken' },
    ];
    const { runId } = await runAndRecord(baseStage({ check: () => defects, revise: undefined }));
    await flushPlanLoopWrites();

    const revs = revisionRows(runId);
    expect(revs).toHaveLength(1);
    expect(revs[0].score).toBe(0);
    expect(revs[0].reason).toBe('deterministic-fail');
    expect(JSON.parse(revs[0].defects)).toEqual(['priority_inversion', 'tag_group_split']);
  });

  it('candidate round-trips: the stored JSON deep-equals what describe() returned', async () => {
    const describe = (c: Cand) => ({ order: c, note: 'compact' });
    const { runId } = await runAndRecord(baseStage({ describe }));
    await flushPlanLoopWrites();

    const revs = revisionRows(runId);
    expect(revs[0].candidate).not.toBeNull();
    expect(JSON.parse(revs[0].candidate as string)).toEqual(describe([0, 1, 2]));
  });

  it('the audit row still lands: one action=plan_revision row per iteration', async () => {
    // Steady +0.2 gains never reach 0.8 within 3 rounds => hard cap, same fixture as
    // loop.test.ts's "stops at maxIterations" case (3 revisions, none passing).
    const roundScore = [0.3, 0.5, 0.7];
    let round = 0;
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: roundScore[round] }));
    const revise = vi.fn(async () => {
      round++;
      return [0, 1, 2];
    });

    const { result } = await runAndRecord(baseStage({ ownerId: SYSTEM_OWNER, judge, revise }), {
      passThreshold: 0.8,
      epsilon: 0.05,
      maxIterations: 3,
    });
    await flushPlanLoopWrites();
    await flushAudits();

    expect(result.revisions).toHaveLength(3);
    expect(auditPlanRevisionCount(SYSTEM_OWNER)).toBe(3);
  });

  it('rows are owner-scoped: two owners never share owner_id on either table', async () => {
    const ownerB = createOwner();

    const { runId: runIdA } = await runAndRecord(baseStage({ ownerId: SYSTEM_OWNER }));
    const { runId: runIdB } = await runAndRecord(baseStage({ ownerId: ownerB }));
    await flushPlanLoopWrites();

    const runA = runsRow(runIdA);
    const runB = runsRow(runIdB);
    expect(runA.owner_id).toBe(SYSTEM_OWNER);
    expect(runB.owner_id).toBe(ownerB);
    expect(runA.owner_id).not.toBe(runB.owner_id);

    const revsA = revisionRows(runIdA);
    const revsB = revisionRows(runIdB);
    expect(revsA.length).toBeGreaterThan(0);
    expect(revsB.length).toBeGreaterThan(0);
    expect(revsA.every((r) => r.owner_id === SYSTEM_OWNER)).toBe(true);
    expect(revsB.every((r) => r.owner_id === ownerB)).toBe(true);
  });

  it('a critique longer than 1000 chars is stored capped at exactly 1000 characters', async () => {
    const longCritique = 'x'.repeat(1500);
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: 0.9, critique: longCritique }));
    const { runId } = await runAndRecord(baseStage({ judge }));
    await flushPlanLoopWrites();

    const revs = revisionRows(runId);
    expect(revs[0].critique.length).toBe(1000);
    expect(revs[0].critique).toBe(longCritique.slice(0, 1000));
  });

  it('a non-serializable candidate (circular reference) is stored as NULL, not thrown', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rev: Revision = { iter: 1, candidate: circular, defects: [], score: 0.9, critique: '', reason: 'judged' };

    expect(() => recordPlanRevision(newId(), SYSTEM_OWNER, 'order', rev)).not.toThrow();
    await flushPlanLoopWrites();

    const row = sqlite.prepare(`SELECT candidate FROM plan_revision_log WHERE iter = 1 ORDER BY at DESC LIMIT 1`).get() as {
      candidate: string | null;
    };
    expect(row.candidate).toBeNull();
  });

  it("a critique ending mid-surrogate-pair at the 1000-char boundary doesn't store a lone surrogate", async () => {
    // 999 ASCII chars + a 2-code-unit emoji straddling indices 999/1000 — a naive
    // slice(0, 1000) would cut the pair in half.
    const critique = 'x'.repeat(999) + '\u{1F600}' + 'trailing text that gets cut off';
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: 0.9, critique }));
    const { runId } = await runAndRecord(baseStage({ judge }));
    await flushPlanLoopWrites();

    const revs = revisionRows(runId);
    const stored = revs[0].critique;
    const lastCode = stored.charCodeAt(stored.length - 1);
    expect(lastCode).not.toBeGreaterThanOrEqual(0xd800);
    expect(stored.length).toBeLessThanOrEqual(1000);
    // The whole emoji was dropped rather than half of it kept — the safe truncation
    // yields 999 chars here, not 1000.
    expect(stored).toBe('x'.repeat(999));
  });
});
