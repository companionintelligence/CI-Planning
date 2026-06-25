import { describe, it, expect, vi } from 'vitest';
import { runLoop, median, type Defect, type JudgeScore, type LoopStage, type Revision } from '../src/agents/loop.js';

// The harness is callback-driven, so these tests never touch Ollama — they assert
// the *harness contract* (Phase M §A0), not any model output. Each test injects a
// `record` sink and an `onEscape` spy so nothing hits the DB and the escape reason
// is observable (the LoopResult deliberately doesn't leak it).

type Cand = number[]; // a toy candidate: an ordering

/** A stage builder with sensible passing defaults; override per test. */
function stage(over: Partial<LoopStage<Cand>> = {}): LoopStage<Cand> {
  return {
    stage: 'order',
    ownerId: 'owner-1',
    generate: vi.fn(async () => [0, 1, 2]),
    check: vi.fn(() => [] as Defect[]),
    baseline: vi.fn(() => [99]),
    judge: vi.fn(async (): Promise<JudgeScore> => ({ overall: 0.9, critique: 'fine' })),
    revise: vi.fn(async (c: Cand) => c),
    ...over,
  };
}

/** Capture every revision the harness records, in order. */
function recorder() {
  const seen: Revision<Cand>[] = [];
  return { record: (_o: string, _s: string, rev: Revision<Cand>) => seen.push(rev), seen };
}

describe('runLoop — §A0 harness contract', () => {
  it('median: odd and even lengths', () => {
    expect(median([0.9, 0.2, 0.85])).toBe(0.85);
    expect(median([0.2, 0.8])).toBeCloseTo(0.5);
    expect(median([])).toBe(0);
  });

  it('happy path: clean candidate passes round 1; judge sampled 3×, no revise', async () => {
    const rec = recorder();
    const onEscape = vi.fn();
    const s = stage();
    const res = await runLoop(s, { record: rec.record, onEscape });

    expect(res.passed).toBe(true);
    expect(res.escaped).toBe(false);
    expect(res.score).toBe(0.9);
    expect(res.iterations).toBe(1);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.judge).toHaveBeenCalledTimes(3); // self-consistency: 3 samples
    expect(s.revise).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
    expect(rec.seen).toHaveLength(1);
    expect(rec.seen[0].reason).toBe('judged');
  });

  it('generator ≠ evaluator: generate gets no candidate; judge gets the candidate', async () => {
    const generate = vi.fn(async () => [5, 6, 7]);
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: 0.95 }));
    await runLoop(stage({ generate, judge }), { record: recorder().record });

    // The generator is invoked with NO arguments — it never receives the candidate
    // under evaluation nor the judging task (reward-hacking guard, structurally).
    expect(generate).toHaveBeenCalledWith();
    expect(generate.mock.calls[0]).toHaveLength(0);
    // The judge only ever receives the candidate produced by the generator.
    expect(judge).toHaveBeenCalledWith([5, 6, 7]);
    expect(generate).not.toBe(judge);
  });

  it('a deterministic failure cannot pass — even at judge 1.0 — and the judge is never consulted', async () => {
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: 1.0 }));
    const onEscape = vi.fn();
    const defect: Defect = { rule: 'priority_inversion', detail: 'index 4 (P1) must precede index 2 (P3)' };
    const res = await runLoop(
      stage({ check: () => [defect], judge, revise: undefined }),
      { record: recorder().record, onEscape },
    );

    expect(res.passed).toBe(false);
    expect(res.escaped).toBe(true);
    expect(res.candidate).toEqual([99]); // the deterministic baseline
    expect(judge).not.toHaveBeenCalled(); // gate short-circuits before any judge cost
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('judge self-consistency: the median of 3 samples gates the pass', async () => {
    // Samples 0.9 / 0.2 / 0.85 → median 0.85 ≥ 0.8 ⇒ pass at score 0.85 (not the mean 0.65).
    const seq = [0.9, 0.2, 0.85];
    let k = 0;
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: seq[k++] }));
    const res = await runLoop(stage({ judge }), { record: recorder().record, passThreshold: 0.8 });

    expect(res.passed).toBe(true);
    expect(res.score).toBe(0.85);
    expect(judge).toHaveBeenCalledTimes(3);
  });

  it('bounded: stops on plateau (gain < ε) and escapes to baseline', async () => {
    // Round 1 scores 0.50, round 2 scores 0.52 (gain 0.02 < ε=0.05) ⇒ plateau.
    const roundScore = [0.5, 0.52, 0.99];
    let round = 0;
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: roundScore[round] }));
    const revise = vi.fn(async () => { round++; return [0, 1, 2]; });
    const onEscape = vi.fn();
    const res = await runLoop(
      stage({ judge, revise }),
      { record: recorder().record, onEscape, passThreshold: 0.8, epsilon: 0.05, maxIterations: 3 },
    );

    expect(res.escaped).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.candidate).toEqual([99]);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onEscape.mock.calls[0][2].reason).toBe('plateau');
    expect(revise).toHaveBeenCalledTimes(1); // revised once (round1→2), then plateaued out
  });

  it('bounded: stops at maxIterations even while still improving', async () => {
    // Steady +0.2 gains never reach 0.8 within 3 rounds ⇒ hard cap, not plateau.
    const roundScore = [0.3, 0.5, 0.7];
    let round = 0;
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: roundScore[round] }));
    const revise = vi.fn(async () => { round++; return [0, 1, 2]; });
    const onEscape = vi.fn();
    const rec = recorder();
    const res = await runLoop(
      stage({ judge, revise }),
      { record: rec.record, onEscape, passThreshold: 0.8, epsilon: 0.05, maxIterations: 3 },
    );

    expect(res.escaped).toBe(true);
    expect(res.score).toBe(0.7); // best seen, but not shipped — baseline is
    expect(res.candidate).toEqual([99]);
    expect(onEscape.mock.calls[0][2].reason).toBe('max-iterations');
    expect(revise).toHaveBeenCalledTimes(2); // rounds 1→2 and 2→3; no revise after the final round
    expect(rec.seen).toHaveLength(3);
  });

  it('append-only log: one row per round, in order, mirrored to the sink', async () => {
    const roundScore = [0.3, 0.5, 0.7];
    let round = 0;
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: roundScore[round] }));
    const revise = vi.fn(async () => { round++; return [0, 1, 2]; });
    const rec = recorder();
    const res = await runLoop(stage({ judge, revise }), { record: rec.record, maxIterations: 3 });

    expect(rec.seen.map((r) => r.iter)).toEqual([1, 2, 3]);
    expect(rec.seen).toEqual(res.revisions); // the returned log and the sink agree
    expect(res.revisions.map((r) => r.score)).toEqual([0.3, 0.5, 0.7]);
  });

  it('cost discipline: exceeding the call budget trips the escape hatch', async () => {
    // budget 2: generate (1) + first judge sample (2); the 2nd sample would be the 3rd call ⇒ trip.
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: 0.95 }));
    const onEscape = vi.fn();
    const res = await runLoop(
      stage({ judge }),
      { record: recorder().record, onEscape, callBudget: 2, judgeSamples: 3 },
    );

    expect(res.escaped).toBe(true);
    expect(res.candidate).toEqual([99]);
    expect(onEscape.mock.calls[0][2].reason).toBe('budget');
    expect(judge).toHaveBeenCalledTimes(1); // tripped on the 2nd judge sample
  });

  it('judge-less stage (A4-style): passing the deterministic checks is the whole rubric', async () => {
    const generate = vi.fn(async () => [1, 2, 3]);
    const res = await runLoop(
      { stage: 'constraints', ownerId: 'o', generate, check: () => [], baseline: () => [] },
      { record: recorder().record },
    );

    expect(res.passed).toBe(true);
    expect(res.candidate).toEqual([1, 2, 3]);
    expect(res.revisions[0].reason).toBe('passed-no-judge');
  });

  it('judge-less stage: a deterministic failure escapes (no revise to fall back on)', async () => {
    const onEscape = vi.fn();
    const res = await runLoop(
      { stage: 'constraints', ownerId: 'o', generate: async () => [1], check: () => [{ rule: 'bad', detail: 'x' }], baseline: () => [-1] },
      { record: recorder().record, onEscape },
    );

    expect(res.passed).toBe(false);
    expect(res.escaped).toBe(true);
    expect(res.candidate).toEqual([-1]);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('escape hatch never spins: generate called once, revise bounded by maxIterations', async () => {
    const generate = vi.fn(async () => [0, 1]);
    const revise = vi.fn(async () => [0, 1]);
    const judge = vi.fn(async (): Promise<JudgeScore> => ({ overall: 0.1 })); // never passes
    await runLoop(
      stage({ generate, judge, revise }),
      { record: recorder().record, passThreshold: 0.8, epsilon: 0, maxIterations: 3 },
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls.length).toBeLessThanOrEqual(2); // ≤ maxIterations-1, never unbounded
  });
});
