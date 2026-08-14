import { describe, it, expect } from 'vitest';
import { CALL_POLICY, resolveCall, type CallPurpose, type CallPolicy } from '../src/mcp/ollama.js';

/**
 * The policy table NAMES the numbers the call sites used before `CALL_POLICY` existed;
 * it does not retune them. This file pins the values that shipped, transcribed from the
 * pre-refactor call sites, so a future retune has to be a deliberate edit here — not a
 * silent drift in `mcp/ollama.ts`.
 *
 * Each row's `site` is where the numbers came from at the commit that introduced the table.
 */
const EXPECTED: { purpose: CallPurpose; site: string; policy: CallPolicy }[] = [
  { purpose: 'classify', site: 'agents/tags.ts, agents/quickadd.ts ×2, services/motivation.ts', policy: { tier: 'fast', temperature: 0.1, timeoutMs: 15_000 } },
  { purpose: 'classify_wide', site: 'services/task-enrich.ts', policy: { tier: 'fast', temperature: 0.2, timeoutMs: 20_000 } },
  { purpose: 'brainstorm', site: 'agents/subtasks.ts', policy: { tier: 'fast', temperature: 0.3, timeoutMs: 20_000 } },
  { purpose: 'extract', site: 'agents/extract.ts', policy: { tier: 'quality', temperature: 0.1, timeoutMs: 60_000 } },
  { purpose: 'plan_generate', site: 'agents/plan.ts generate + revise', policy: { tier: 'fast', temperature: 0.2, timeoutMs: 25_000 } },
  { purpose: 'plan_judge', site: 'agents/plan.ts judge', policy: { tier: 'quality', temperature: 0.1, timeoutMs: 30_000 } },
  { purpose: 'plan_narrate', site: 'agents/plan.ts rationales, services/triality-rationale.ts', policy: { tier: 'fast', temperature: 0.3, timeoutMs: 25_000 } },
  { purpose: 'plan_instruct', site: 'agents/plan.ts parseInstruction', policy: { tier: 'fast', temperature: 0.1, timeoutMs: 25_000 } },
  { purpose: 'suggest', site: 'agents/memory-suggest.ts (its implicit 0.2 made explicit)', policy: { tier: 'fast', temperature: 0.2, timeoutMs: 30_000 } },
  { purpose: 'narrate', site: 'agents/summarize.ts', policy: { tier: 'quality', temperature: 0.4, timeoutMs: 60_000 } },
  { purpose: 'voice', site: 'agents/render-copy.ts (fast-tier pair; tier + timeout passed per surface)', policy: { tier: 'fast', temperature: 0.7, timeoutMs: 15_000 } },
];

describe('CALL_POLICY', () => {
  it.each(EXPECTED)('$purpose resolves to the values $site used', ({ purpose, policy }) => {
    expect(resolveCall({ purpose })).toEqual(policy);
    expect(CALL_POLICY[purpose]).toEqual(policy);
  });

  it('covers exactly the purposes the table names — no orphans, no strays', () => {
    expect(Object.keys(CALL_POLICY).sort()).toEqual(EXPECTED.map((e) => e.purpose).sort());
  });

  it('every timeout is a whole number of milliseconds in a sane range', () => {
    for (const [purpose, p] of Object.entries(CALL_POLICY)) {
      expect(Number.isInteger(p.timeoutMs), purpose).toBe(true);
      expect(p.timeoutMs, purpose).toBeGreaterThanOrEqual(5_000);
      expect(p.timeoutMs, purpose).toBeLessThanOrEqual(120_000);
      expect(p.temperature, purpose).toBeGreaterThanOrEqual(0);
      expect(p.temperature, purpose).toBeLessThanOrEqual(1);
    }
  });

  /**
   * `agents/loop.ts` expresses "the generator is never the evaluator" as a TIER SPLIT:
   * the §A0 generator runs on `fast`, the judge on `quality`. Merging or aliasing the
   * four plan_* rows — even where two of them would coincide — would erase that contract
   * silently, so it is asserted rather than left to a comment.
   */
  describe('§A0 runner contract', () => {
    it('keeps the four plan_* purposes as distinct entries', () => {
      const planPurposes = Object.keys(CALL_POLICY).filter((k) => k.startsWith('plan_'));
      expect(planPurposes.sort()).toEqual(['plan_generate', 'plan_instruct', 'plan_judge', 'plan_narrate']);
      // Distinct object identities: no row aliases another.
      const seen = new Set(planPurposes.map((k) => CALL_POLICY[k as CallPurpose]));
      expect(seen.size).toBe(4);
    });

    it('runs the judge on a different tier from the generator', () => {
      expect(CALL_POLICY.plan_generate.tier).toBe('fast');
      expect(CALL_POLICY.plan_judge.tier).toBe('quality');
      expect(CALL_POLICY.plan_judge.tier).not.toBe(CALL_POLICY.plan_generate.tier);
    });
  });

  /**
   * Preserved on purpose (llm-2 open question): `classify` and `classify_wide` do a
   * similar job at different temperatures. The named table makes that difference
   * askable; resolving it is a separate, measured ticket.
   */
  it('preserves the classify / classify_wide temperature split', () => {
    expect(CALL_POLICY.classify.temperature).toBe(0.1);
    expect(CALL_POLICY.classify_wide.temperature).toBe(0.2);
  });
});

describe('resolveCall precedence', () => {
  it('lets an explicit value override the purpose', () => {
    expect(resolveCall({ purpose: 'classify', temperature: 0.9 })).toEqual({ tier: 'fast', temperature: 0.9, timeoutMs: 15_000 });
    expect(resolveCall({ purpose: 'classify', timeoutMs: 99_000 })).toEqual({ tier: 'fast', temperature: 0.1, timeoutMs: 99_000 });
    expect(resolveCall({ purpose: 'classify', tier: 'quality' })).toEqual({ tier: 'quality', temperature: 0.1, timeoutMs: 15_000 });
  });

  it('overrides render-copy style: voice temperature with a per-surface tier and timeout', () => {
    expect(resolveCall({ purpose: 'voice', tier: 'quality', timeoutMs: 45_000 })).toEqual({ tier: 'quality', temperature: 0.7, timeoutMs: 45_000 });
    expect(resolveCall({ purpose: 'voice', tier: 'fast', timeoutMs: 15_000 })).toEqual({ tier: 'fast', temperature: 0.7, timeoutMs: 15_000 });
  });

  it('keeps the historical bare-generate() defaults when no purpose is named', () => {
    expect(resolveCall()).toEqual({ tier: 'fast', temperature: 0.2, timeoutMs: 60_000 });
    expect(resolveCall({ tier: 'quality' })).toEqual({ tier: 'quality', temperature: 0.2, timeoutMs: 60_000 });
  });

  it('treats temperature 0 as an explicit override, not as absent', () => {
    expect(resolveCall({ purpose: 'voice', temperature: 0 }).temperature).toBe(0);
  });
});
