import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enrichQuick, type QuickHints } from '../src/agents/quickadd.js';
import type { ParsedQuick } from '../src/engine/quickadd.js';
import { exemplarPrompt } from '../src/services/classification-learning.js';
import {
  directionGuide,
  PRIORITY_RUBRIC, DURATION_RUBRIC, TIME_OF_DAY_RUBRIC, COMPLEXITY_RUBRIC, MOTIVATION_RUBRIC,
} from '../src/agents/rubric.js';

/**
 * The classification hint inside quick-add's `enrichQuick` prompt (2 Nov 2026).
 *
 * The seam is `generateJson`, stubbed so the PROMPT is the thing under test: what the model
 * is shown is the behaviour here, and the contract is that an owner with no corrections is
 * shown today's prompt byte for byte. Partial mock, not a wholesale replacement — only the
 * model seam may be stubbed.
 */
const { prompts, reply } = vi.hoisted(() => ({
  prompts: [] as string[],
  // Includes a direction, so the second-chance call stays quiet unless a test removes it.
  reply: { value: { direction: 'work', categories: ['health'], motivation: 'me' } as Record<string, unknown> },
}));
vi.mock('../src/mcp/ollama.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mcp/ollama.js')>()),
  generateJson: async (prompt: string) => {
    prompts.push(prompt);
    return reply.value;
  },
}));

const NO_CATS = { directions: ['work', 'home', 'community'], others: ['email'] };
const VOCAB = { ...NO_CATS, categories: ['health', 'leisure'] };
const TEXT = 'gym session';
const PARSED: ParsedQuick = { title: TEXT, tags: [] };

/**
 * The prompt `enrichQuick` composed BEFORE the hint existed, as a literal. Written against
 * the unedited agents/quickadd.ts and run there first (a fourth argument is ignored at
 * runtime), so this is today's prompt and not a description of the new one. The rubric
 * constants and `directionGuide` are substituted rather than copied: they are pinned in
 * enrichment-rubric.test.ts, and this pin is about the layout around them.
 */
const golden = (withCategories: boolean): string =>
  `Classify this quick task entry. Reply with JSON with exactly these keys.\n` +
  `"direction": REQUIRED — exactly one of ["work","home","community"]. ` +
  `Every task has a direction, always choose one.${directionGuide(NO_CATS.directions)}\n` +
  `"isComplex": true or false. ${COMPLEXITY_RUBRIC}\n` +
  `"priority": 1-4. ${PRIORITY_RUBRIC}\n` +
  `"estimatedMinutes": a number or null. ${DURATION_RUBRIC}\n` +
  `"timeOfDay": one of "morning","afternoon","evening","any". ${TIME_OF_DAY_RUBRIC}\n` +
  `"timeOfDayReason": a few words on why, or null.\n` +
  `"motivation": one of "me","us","them", or null. ${MOTIVATION_RUBRIC}\n` +
  (withCategories ? `"categories": 1-3 life areas from ["health","leisure"], best fit first.\n` : '') +
  `"tags": up to 2 from ["email"], else [].\n` +
  `Choose direction/categories/tags ONLY from the given lists — never invent.\n` +
  `Entry: "gym session"`;

beforeEach(() => {
  prompts.length = 0;
  reply.value = { direction: 'work', categories: ['health'], motivation: 'me' };
});

describe('enrichQuick prompt with no hint', () => {
  it('is byte-identical to the pre-hint prompt however "no hint" is spelled', async () => {
    const spellings: (QuickHints | undefined)[] = [
      undefined,
      {},
      { category: '', motivation: '' },
      { category: undefined, motivation: undefined },
    ];
    for (const hints of spellings) {
      prompts.length = 0;
      await enrichQuick(TEXT, PARSED, VOCAB, hints);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toBe(golden(true));
    }
  });

  it('keeps the three-argument call (rubric-live-measure, route stubs) on the same prompt', async () => {
    await enrichQuick(TEXT, PARSED, VOCAB);
    expect(prompts[0]).toBe(golden(true));
  });

  it('is unchanged for an owner with no categories', async () => {
    await enrichQuick(TEXT, PARSED, NO_CATS);
    expect(prompts[0]).toBe(golden(false));
  });
});

// Real exemplarPrompt output, so the test places what the route will actually hand over.
const CATEGORY_HINT = exemplarPrompt([
  { logId: 'a', inputText: 'gym session before work', llmValue: 'leisure', correctValue: 'health' },
]);
const MOTIVATION_HINT = exemplarPrompt([
  { logId: 'b', inputText: 'help mum with her taxes', llmValue: 'me', correctValue: 'them' },
]);
const BOTH = { category: CATEGORY_HINT, motivation: MOTIVATION_HINT };

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('enrichQuick prompt with hints', () => {
  it('only adds: removing each hint and its one extra newline leaves the pre-hint prompt', async () => {
    await enrichQuick(TEXT, PARSED, VOCAB, BOTH);
    const stripped = prompts[0]
      .replace(`${CATEGORY_HINT}\n`, '')
      .replace(`${MOTIVATION_HINT}\n`, '');
    expect(stripped).toBe(golden(true));
  });

  it('adds only the hint that was given', async () => {
    await enrichQuick(TEXT, PARSED, VOCAB, { category: CATEGORY_HINT });
    expect(prompts[0].replace(`${CATEGORY_HINT}\n`, '')).toBe(golden(true));
    expect(prompts[0]).not.toContain('help mum');

    prompts.length = 0;
    await enrichQuick(TEXT, PARSED, VOCAB, { motivation: MOTIVATION_HINT });
    expect(prompts[0].replace(`${MOTIVATION_HINT}\n`, '')).toBe(golden(true));
    expect(prompts[0]).not.toContain('gym session before work');
  });

  it('puts each lesson right after the field it governs, and keeps the tail last', async () => {
    await enrichQuick(TEXT, PARSED, VOCAB, BOTH);
    const p = prompts[0];
    const at = (needle: string) => p.indexOf(needle);
    expect(at('"motivation":')).toBeGreaterThan(-1);
    expect(at('"motivation":')).toBeLessThan(at('you said me; the user chose them'));
    expect(at('you said me; the user chose them')).toBeLessThan(at('"categories":'));
    expect(at('"categories":')).toBeLessThan(at('you said leisure; the user chose health'));
    expect(at('you said leisure; the user chose health')).toBeLessThan(at('"tags":'));

    // A blank line on both sides, so a lesson never reads as part of the next field.
    expect(p).toContain(`${MOTIVATION_RUBRIC}\n\nThis user has corrected you before.`);
    expect(p).toContain(`the user chose health.\n\n"tags":`);

    // Once each, and the never-invent rule and the entry stay the last two lines.
    expect(count(p, 'you said me; the user chose them')).toBe(1);
    expect(count(p, 'you said leisure; the user chose health')).toBe(1);
    expect(p.endsWith('never invent.\nEntry: "gym session"')).toBe(true);
  });

  it('asks no categories question when the owner has no categories, and shows no lesson about it', async () => {
    await enrichQuick(TEXT, PARSED, NO_CATS, { category: CATEGORY_HINT });
    expect(prompts[0]).toBe(golden(false));
    expect(prompts[0]).not.toContain('"categories":');
    expect(prompts[0]).not.toContain('corrected you before');
  });

  it('still shows the motivation lesson when the owner has no categories', async () => {
    await enrichQuick(TEXT, PARSED, NO_CATS, BOTH);
    expect(prompts[0].replace(`${MOTIVATION_HINT}\n`, '')).toBe(golden(false));
    expect(count(prompts[0], 'corrected you before')).toBe(1);
    expect(prompts[0]).toContain('you said me; the user chose them');
  });
});

describe('the direction retry', () => {
  it('is a single-field question that never carries a hint, with or without hints', async () => {
    // No usable direction in the first answer, so the second-chance call fires.
    reply.value = { categories: ['health'], motivation: 'me' };

    await enrichQuick(TEXT, PARSED, VOCAB);
    expect(prompts).toHaveLength(2);
    const stock = prompts[1];
    expect(stock).toContain('Which area of life does this task belong to?');

    prompts.length = 0;
    await enrichQuick(TEXT, PARSED, VOCAB, BOTH);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('corrected you before');
    expect(prompts[1]).not.toContain('corrected you before');
    expect(prompts[1]).toBe(stock);
  });
});
