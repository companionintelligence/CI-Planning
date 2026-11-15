import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enrichQuick } from '../src/agents/quickadd.js';
import { CALL_POLICY, resolveCall } from '../src/mcp/ollama.js';
import type { ParsedQuick } from '../src/engine/quickadd.js';

/**
 * Quick add's classification runs on the QUALITY tier (2 Nov 2026, docs/quickadd-quality-tier-2026-11.md):
 * the fast default, qwen2.5:0.5b, gave a category that was right on 20 of 60 obvious-title answers and
 * three of nine keys, where gemma3n:e4b, the quality default, was right on 60 of 60 with all nine.
 *
 * The seam is `generateJson`, stubbed so the OPTIONS each call carries are the thing under test: the tier
 * is not visible in the answer. Partial mock, not a wholesale replacement.
 */
const { calls, reply } = vi.hoisted(() => ({
  calls: [] as { prompt: string; opts: Record<string, unknown> | undefined }[],
  reply: { value: { direction: 'home', categories: ['health'] } as Record<string, unknown> },
}));
vi.mock('../src/mcp/ollama.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mcp/ollama.js')>()),
  generateJson: async (prompt: string, opts?: Record<string, unknown>) => {
    calls.push({ prompt, opts });
    return reply.value;
  },
}));

const VOCAB = { directions: ['work', 'home', 'community'], categories: ['health', 'leisure'], others: ['email'] };
const PARSED: ParsedQuick = { title: 'gym session', tags: [] };

beforeEach(() => {
  calls.length = 0;
  reply.value = { direction: 'home', categories: ['health'] };
});

describe('quick add asks the quality tier', () => {
  it('sends tier quality on the overlay call, with the classify purpose it always had', async () => {
    await enrichQuick('gym session', PARSED, VOCAB);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ purpose: 'classify', tier: 'quality' });
  });

  it('sends it on the direction retry too, and that retry is the only other call', async () => {
    reply.value = { categories: ['health'] }; // no usable direction: the single-field question is asked
    await enrichQuick('gym session', PARSED, VOCAB);
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('Which area of life does this task belong to?');
    for (const c of calls) expect(c.opts).toEqual({ purpose: 'classify', tier: 'quality' });
  });

  it('keeps the classify purpose\'s temperature and ceiling, so only the tier moved', async () => {
    await enrichQuick('gym session', PARSED, VOCAB);
    expect(resolveCall(calls[0].opts as Parameters<typeof resolveCall>[0])).toEqual({ tier: 'quality', temperature: 0.1, timeoutMs: 15_000 });
  });

  it('moves no other caller: the classify purpose is still the fast tier', () => {
    // tags.ts, motivation.ts and the Monday scorer name the purpose alone and keep it; llm-call-policy.test.ts
    // pins every row, so this is the one-line statement of what this change did not touch.
    expect(CALL_POLICY.classify.tier).toBe('fast');
    expect(CALL_POLICY.plan_generate.tier).toBe('fast');
    expect(CALL_POLICY.plan_judge.tier).toBe('quality');
  });

  it('leaves the prompt as it was: the same stock prompt, whatever the tier', async () => {
    await enrichQuick('gym session', PARSED, VOCAB);
    expect(calls[0].prompt.startsWith('Classify this quick task entry. Reply with JSON with exactly these keys.\n')).toBe(true);
    expect(calls[0].prompt).toContain('"categories": 1-3 life areas from ["health","leisure"], best fit first.\n"tags":');
    expect(calls[0].prompt.endsWith('Entry: "gym session"')).toBe(true);
  });
});
