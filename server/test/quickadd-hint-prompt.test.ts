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
const CATEGORY_LESSON = 'you said leisure; the user chose health';
const MOTIVATION_LESSON = 'you said me; the user chose them';

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// The layout, as a function of the golden prompt: the blocks go between the never-invent
// rule and the entry, as they are, with nothing added around them. Built from the golden
// and not from enrichQuick, so a layout that drifts (a block beside its field, after the
// entry, in the other order, with an extra newline) cannot agree with itself.
const ENTRY = `Entry: "${TEXT}"`;
const withLessonsLast = (stock: string, lessons: string): string => {
  expect(stock.endsWith(`never invent.\n${ENTRY}`)).toBe(true);
  return stock.slice(0, -ENTRY.length) + lessons + ENTRY;
};

describe('enrichQuick prompt with hints', () => {
  it('only adds: removing exactly the hint strings leaves the pre-hint prompt', async () => {
    await enrichQuick(TEXT, PARSED, VOCAB, BOTH);
    const p = prompts[0];
    // No extra newline rides along with a block, so the bare hint strings are all that go.
    expect(count(p, CATEGORY_HINT)).toBe(1);
    expect(count(p, MOTIVATION_HINT)).toBe(1);
    expect(p.replace(CATEGORY_HINT, '').replace(MOTIVATION_HINT, '')).toBe(golden(true));
  });

  it('adds only the hint that was given', async () => {
    await enrichQuick(TEXT, PARSED, VOCAB, { category: CATEGORY_HINT });
    expect(prompts[0]).toBe(withLessonsLast(golden(true), CATEGORY_HINT));
    expect(prompts[0].replace(CATEGORY_HINT, '')).toBe(golden(true));
    expect(prompts[0]).not.toContain('help mum');

    prompts.length = 0;
    await enrichQuick(TEXT, PARSED, VOCAB, { motivation: MOTIVATION_HINT });
    expect(prompts[0]).toBe(withLessonsLast(golden(true), MOTIVATION_HINT));
    expect(prompts[0].replace(MOTIVATION_HINT, '')).toBe(golden(true));
    expect(prompts[0]).not.toContain('gym session before work');
  });

  it('puts the lessons last: after the never-invent rule, right before the entry, motivation first', async () => {
    await enrichQuick(TEXT, PARSED, VOCAB, BOTH);
    const p = prompts[0];

    // The whole prompt, once: the pre-hint prompt with the two blocks in front of the entry.
    expect(p).toBe(withLessonsLast(golden(true), MOTIVATION_HINT + CATEGORY_HINT));

    // The same, as an order. Every field line and the rule after them come before either
    // lesson, so a lesson beside its field cannot pass (it would sit before '"tags":').
    const at = (needle: string) => p.indexOf(needle);
    expect(at('"motivation":')).toBeGreaterThan(-1);
    expect(at('"motivation":')).toBeLessThan(at('"categories":'));
    expect(at('"categories":')).toBeLessThan(at('"tags":'));
    expect(at('"tags":')).toBeLessThan(at('never invent.'));
    expect(at('never invent.')).toBeLessThan(at(MOTIVATION_LESSON));
    expect(at(MOTIVATION_LESSON)).toBeLessThan(at(CATEGORY_LESSON));
    expect(at(CATEGORY_LESSON)).toBeLessThan(at(ENTRY));
    expect(p.slice(0, at('never invent.'))).not.toContain('corrected you before');

    // A blank line before the block and between the two, none before the entry: the entry
    // follows the last block directly.
    expect(p).toContain('never invent.\n\nThis user has corrected you before');
    expect(p).toContain(`${MOTIVATION_LESSON}.\n\nThis user has corrected you before`);
    expect(p).toContain(`${CATEGORY_LESSON}.\n${ENTRY}`);
    expect(p).not.toContain(`\n\n${ENTRY}`);
    expect(p).not.toContain('\n\n\n');

    // The field lines are the pre-hint lines, touching: nothing sits between them.
    expect(p).toContain(`${MOTIVATION_RUBRIC}\n"categories":`);
    expect(p).toContain('best fit first.\n"tags":');

    // Once each, and the entry is the tail.
    expect(count(p, MOTIVATION_LESSON)).toBe(1);
    expect(count(p, CATEGORY_LESSON)).toBe(1);
    expect(count(p, 'corrected you before')).toBe(2);
    expect(p.endsWith(`${CATEGORY_LESSON}.\n${ENTRY}`)).toBe(true);
  });

  it('asks no categories question when the owner has no categories, and shows no lesson about it', async () => {
    await enrichQuick(TEXT, PARSED, NO_CATS, { category: CATEGORY_HINT });
    expect(prompts[0]).toBe(golden(false));
    expect(prompts[0]).not.toContain('"categories":');
    expect(prompts[0]).not.toContain('corrected you before');
  });

  it('still shows the motivation lesson when the owner has no categories', async () => {
    await enrichQuick(TEXT, PARSED, NO_CATS, BOTH);
    expect(prompts[0]).toBe(withLessonsLast(golden(false), MOTIVATION_HINT));
    expect(prompts[0].replace(MOTIVATION_HINT, '')).toBe(golden(false));
    expect(count(prompts[0], 'corrected you before')).toBe(1);
    expect(prompts[0]).toContain(MOTIVATION_LESSON);
    expect(prompts[0]).not.toContain(CATEGORY_LESSON);
    expect(prompts[0].indexOf('"tags":')).toBeLessThan(prompts[0].indexOf(MOTIVATION_LESSON));
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
