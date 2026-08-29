/**
 * Phase M §A0 — the AI-in-the-loop authoring harness.
 *
 * Turns a one-shot LLM call into a **bounded, scored, inspectable** revision loop:
 * generate → evaluate → revise, with the generator and the evaluator kept strictly
 * separate so a model never grades its own work. Every AI authoring stage in
 * Phase M (A1 ordering, A3 rationale, A4 constraints, B4 re-author) runs through
 * this one runner, so the contract below is enforced in exactly one place.
 *
 * The runner is **tier-agnostic and transport-agnostic**: callers supply the
 * generator / judge / reviser as plain async callbacks (each wraps its own Ollama
 * prompt at the tier it wants — generator `small`, judge `medium`). That keeps the
 * prompts with the stage that owns them and makes the loop unit-testable with mock
 * callbacks (CI has no Ollama; see loop.test.ts).
 *
 * The seven contract clauses (Phase M §A0), and where each lives below:
 *  1. Generator ≠ evaluator      → distinct `generate`/`judge` callbacks; judge never sees the generator's reasoning.
 *  2. Rubric = checks + judge     → a candidate PASSES only when `check()` returns no defects AND the judge median ≥ threshold.
 *  3. Self-consistency on judge    → judge sampled `judgeSamples`× (default 3), median taken; checks run once.
 *  4. Bounded recursion            → `maxIterations` hard cap PLUS plateau detection (stop when gains < ε).
 *  5. Append-only revision log     → every candidate + its scores appended (audit_log by default) and returned.
 *  6. Human escape hatch on stall  → on stall we DO NOT ship the best failing candidate; we fall back to `baseline()` and signal.
 *  7. Cost discipline              → a global per-run `callBudget` trips the escape hatch when exceeded.
 */
import { writeAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

/** A single deterministic rule violation — the hard gate. `detail` is fed verbatim to the reviser's must-fix list. */
export interface Defect {
  /** Stable machine code for the rule, e.g. 'priority_inversion'. */
  rule: string;
  /** Human-readable description, e.g. "index 4 (P1) must come before index 2 (P3)". */
  detail: string;
}

/** One independent judge sample. `overall` (in [0,1]) is what the median gates on; extra named dims are advisory. */
export interface JudgeScore {
  overall: number;
  /** One sentence on the biggest weakness — surfaced to the reviser. */
  critique?: string;
  [dim: string]: number | string | undefined;
}

/** Why a round scored what it did — recorded for inspectability. */
export type ScoreReason = 'deterministic-fail' | 'judged' | 'passed-no-judge';

/** One entry in the append-only revision log: a candidate and how it scored. */
export interface Revision {
  iter: number;
  /** A compact view of the candidate for the log (defaults to the candidate itself). */
  candidate: unknown;
  defects: Defect[];
  /** Judge median overall in [0,1]; 0 when a deterministic check failed (judge skipped). */
  score: number;
  critique: string;
  reason: ScoreReason;
}

export interface LoopResult<C> {
  /** The candidate to use: the passing one, or the deterministic baseline on stall. */
  candidate: C;
  /** True iff some candidate cleared every deterministic check AND the judge median met the threshold. */
  passed: boolean;
  /** True iff the loop stalled (max-iter / plateau / budget) and fell back to `baseline()`. */
  escaped: boolean;
  /** Best judge median observed across candidates that cleared the deterministic gate (−1 if none did). */
  score: number;
  iterations: number;
  /** The append-only revision log, oldest first. */
  revisions: Revision[];
}

/** The three prompts + the deterministic rubric for one authoring stage. */
export interface LoopStage<C> {
  /** Stage name for the audit log + escape signal, e.g. 'order'. */
  stage: string;
  ownerId: string;
  /** PROMPT 1 — produce the first candidate (typically `small` tier). */
  generate: () => Promise<C>;
  /** Deterministic, single-pass checks. An empty array means all pass — this is the hard gate the judge can't override. */
  check: (cand: C) => Defect[];
  /** Deterministic fallback used verbatim when the loop stalls (the escape hatch). */
  baseline: () => C;
  /**
   * PROMPT 2 — one INDEPENDENT judge sample (typically `medium` tier). The judge gets the
   * candidate, never the generator's reasoning. Omit for a deterministic-only stage (e.g. A4),
   * where passing the `check()` is the whole rubric.
   */
  judge?: (cand: C) => Promise<JudgeScore>;
  /**
   * PROMPT 3 — repair a flawed candidate (typically `small` tier), given the mechanical
   * defects and the judge's critique. Omit for single-shot stages.
   */
  revise?: (cand: C, defects: Defect[], critique: string) => Promise<C>;
  /** Optional compact representation for the audit row (defaults to the candidate itself). */
  describe?: (cand: C) => unknown;
}

export interface LoopOptions {
  /** Hard cap on generate+revise rounds. Default 3. */
  maxIterations?: number;
  /** Judge samples per round for self-consistency; the median gates PASS. Default 3. */
  judgeSamples?: number;
  /** Judge-median threshold a candidate must meet to pass. Default 0.8. */
  passThreshold?: number;
  /** Plateau gain floor: stop early if the best score improves by less than this over a round. Default 0.05. */
  epsilon?: number;
  /**
   * Global per-run LLM-call budget (generate + revise + each judge sample count as one).
   * Exceeding it trips the escape hatch. Default: `maxIterations * (1 + judgeSamples) + 1`,
   * i.e. generous enough never to bind unless explicitly lowered.
   */
  callBudget?: number;
  /** Sink for each revision (default: append to audit_log). Injected in tests. */
  record?: (ownerId: string, stage: string, rev: Revision) => void;
  /** Called once when the loop stalls. Default: logger.warn. The authoring caller ALSO checks
   * `result.escaped` and raises a "plan needs review" signal there (writeAudit + SSE) — see
   * agents/plan.ts signalPlanNeedsReview. (B4's disruption nudge is a separate path in auto-defense.) */
  onEscape?: (ownerId: string, stage: string, info: { score: number; iterations: number; reason: string }) => void;
}

const DEFAULTS = { maxIterations: 3, judgeSamples: 3, passThreshold: 0.8, epsilon: 0.05 } as const;

/** Median of a non-empty number array (average of the two middle values for even length). */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Default revision sink: append one compact row to audit_log (never throws — audit is fire-and-forget). */
function auditRecord(ownerId: string, stage: string, rev: Revision): void {
  writeAudit({
    ownerId,
    actor: 'system',
    action: 'plan_revision',
    entity: JSON.stringify({
      stage,
      iter: rev.iter,
      score: rev.score,
      reason: rev.reason,
      defects: rev.defects.map((d) => d.rule),
      critique: rev.critique || undefined,
      candidate: rev.candidate,
    }).slice(0, 4000), // entity is a single TEXT column; cap pathological candidates
  });
}

/**
 * Run one authoring stage as a bounded generate → evaluate → revise loop.
 *
 * Returns the passing candidate, or — on stall (max-iter / plateau / budget) — the
 * deterministic `baseline()`, never the best *failing* candidate. The caller decides
 * what to do with `result.escaped` (Workstream A persists deterministic positions AND
 * raises a "plan needs review" signal — audit row + SSE — so the fallback isn't silent).
 */
export async function runLoop<C>(stage: LoopStage<C>, options: LoopOptions = {}): Promise<LoopResult<C>> {
  const maxIterations = options.maxIterations ?? DEFAULTS.maxIterations;
  const judgeSamples = options.judgeSamples ?? DEFAULTS.judgeSamples;
  const passThreshold = options.passThreshold ?? DEFAULTS.passThreshold;
  const epsilon = options.epsilon ?? DEFAULTS.epsilon;
  const callBudget = options.callBudget ?? maxIterations * (1 + judgeSamples) + 1;
  const record = options.record ?? auditRecord;
  const onEscape = options.onEscape ?? ((owner, s, info) =>
    logger.warn('plan loop escaped — falling back to deterministic baseline', { owner, stage: s, ...info }));
  const describe = stage.describe ?? ((c: C) => c as unknown);

  const revisions: Revision[] = [];
  let calls = 0;
  /** Run a counted LLM call, tripping the escape hatch (via throw) if it would exceed the budget. */
  const budgeted = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (calls >= callBudget) throw new BudgetExceeded();
    calls++;
    return fn();
  };

  const escape = (reason: string, bestScore: number, iterations: number): LoopResult<C> => {
    onEscape(stage.ownerId, stage.stage, { score: bestScore, iterations, reason });
    return { candidate: stage.baseline(), passed: false, escaped: true, score: bestScore, iterations, revisions };
  };

  let bestScore = -1;
  let prevBest = -1;

  try {
    let cand = await budgeted(() => stage.generate());

    for (let iter = 1; iter <= maxIterations; iter++) {
      const defects = stage.check(cand); // deterministic gate runs once per round
      let score = 0;
      let critique = '';
      let reason: ScoreReason;

      if (defects.length > 0) {
        // A deterministic failure CANNOT pass, even at judge 1.0 — so don't waste judge calls on it.
        reason = 'deterministic-fail';
      } else if (stage.judge) {
        const samples: JudgeScore[] = [];
        for (let k = 0; k < judgeSamples; k++) samples.push(await budgeted(() => stage.judge!(cand)));
        score = median(samples.map((s) => clamp01(s.overall)));
        critique = pickCritique(samples, score);
        reason = 'judged';
      } else {
        // No judge → deterministic-only stage (A4): clearing the checks IS the pass.
        score = 1;
        reason = 'passed-no-judge';
      }

      const rev: Revision = { iter, candidate: describe(cand), defects, score, critique, reason };
      revisions.push(rev);
      record(stage.ownerId, stage.stage, rev);

      // Only a round that CLEARED the deterministic gate counts toward the best score.
      // `score` is 0 for a deterministic-fail round by construction (never judged), and
      // `0 > -1` is true — so without this guard the very first deterministic failure
      // dragged bestScore up to 0 regardless of whether anything was ever judged,
      // making the documented "-1 if none did" (LoopResult.score) impossible to
      // observe. That is a real distinction a caller may need: "every candidate was
      // rejected outright by a hard rule" and "candidates passed the rules and still
      // judged at 0" are different failures with different fixes.
      if (reason !== 'deterministic-fail' && score > bestScore) bestScore = score;

      if (defects.length === 0 && score >= passThreshold) {
        return { candidate: cand, passed: true, escaped: false, score: bestScore, iterations: iter, revisions };
      }

      // Plateau: after the first round, stop if the best score barely moved.
      if (iter > 1 && bestScore - prevBest < epsilon) return escape('plateau', bestScore, iter);
      prevBest = bestScore;

      // Can't revise (single-shot stage, or final round) → stall.
      if (!stage.revise || iter === maxIterations) break;
      cand = await budgeted(() => stage.revise!(cand, defects, critique));
    }

    return escape('max-iterations', bestScore, Math.min(revisions.length, maxIterations));
  } catch (err) {
    if (err instanceof BudgetExceeded) return escape('budget', bestScore, revisions.length);
    throw err; // a genuine generator/judge error is the caller's to handle (they degrade on Ollama-down)
  }
}

class BudgetExceeded extends Error {
  constructor() {
    super('plan loop call budget exceeded');
    this.name = 'BudgetExceeded';
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** The critique from the sample whose overall is closest to the median (the representative round). */
function pickCritique(samples: JudgeScore[], med: number): string {
  let best = samples[0];
  let bestDist = Infinity;
  for (const s of samples) {
    const d = Math.abs(clamp01(s.overall) - med);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return typeof best?.critique === 'string' ? best.critique : '';
}
