import { describe, it, expect, vi } from 'vitest';
import { mergeEnrichment } from '../src/agents/quickadd.js';
import { suggestSubtasks } from '../src/agents/subtasks.js';
import type { ParsedQuick } from '../src/engine/quickadd.js';
import {
  directionGuide, isTimeOfDay, titleSuggestsComplex,
  PRIORITY_RUBRIC, DURATION_RUBRIC, TIME_OF_DAY_RUBRIC, COMPLEXITY_RUBRIC, COMPLEXITY_DEFINITION,
} from '../src/agents/rubric.js';

// Capture the prompt the subtask suggester actually composes, without a model.
const { prompts } = vi.hoisted(() => ({ prompts: [] as string[] }));
// Partial mock, NOT a wholesale replacement: `suggestSubtasks` wraps its call in the real
// `llmOrNull` (llm-3), so the module's other exports must survive or the wrapper is
// undefined at call time. Only the model seam is stubbed.
vi.mock('../src/mcp/ollama.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mcp/ollama.js')>()),
  generateJson: async (prompt: string) => {
    prompts.push(prompt);
    return { isBreakdownUseful: false, subtasks: [] };
  },
}));

const VOCAB = { directions: ['work', 'home', 'community'], others: ['email', 'errands'], categories: ['health'] };
const base = (over: Partial<ParsedQuick> = {}): ParsedQuick => ({ title: 'x', tags: [], ...over });

// ── The rubric text itself ───────────────────────────────────────────────────
// These assert the CONTRACT the prompt makes with the model, not prose. Each one
// corresponds to a failure mode we actually hit: unqualified buckets → everything is P1;
// bare direction labels → "Dad's birthday" reads as Work; no null escape → invented
// estimates; no band/clock split → a hard pin from a vague preference.

describe('rubric text', () => {
  it('gives priority an explicit default so the model stops guessing high', () => {
    expect(PRIORITY_RUBRIC).toMatch(/THE DEFAULT IS 3/);
    expect(PRIORITY_RUBRIC).toMatch(/When in doubt, answer 3/i);
  });

  it('qualifies every priority bucket, not just "1 is highest"', () => {
    for (const n of ['1 =', '2 =', '3 =', '4 =']) expect(PRIORITY_RUBRIC).toContain(n);
    expect(PRIORITY_RUBRIC).toMatch(/urgent AND important/i); // P1 needs BOTH
    expect(PRIORITY_RUBRIC).toMatch(/blocked/i);              // the other P1 trigger
  });

  it('lets the model decline a duration instead of inventing one', () => {
    expect(DURATION_RUBRIC).toMatch(/null/);
    expect(DURATION_RUBRIC).toMatch(/multiple of 5/i);
  });

  it('states that best-time is a band, never a clock time', () => {
    expect(TIME_OF_DAY_RUBRIC).toMatch(/never invent a specific hour/i);
    for (const b of ['morning', 'afternoon', 'evening', 'any']) expect(TIME_OF_DAY_RUBRIC).toContain(b);
  });

  it('keeps "complex" narrow so the extra subtask call stays rare', () => {
    expect(COMPLEXITY_RUBRIC).toMatch(/several distinct steps/i);
    expect(COMPLEXITY_RUBRIC).toMatch(/trip/i); // the case that regressed live
    expect(COMPLEXITY_RUBRIC).toMatch(/false for anything done in one sitting/i);
    // Worked examples on BOTH sides — a 3B model imitates far better than it deduces.
    expect(COMPLEXITY_RUBRIC).toMatch(/Examples:/);
    expect(COMPLEXITY_RUBRIC).toMatch(/→ true/);
    expect(COMPLEXITY_RUBRIC).toMatch(/→ false/);
  });

  // The split (llm-9) moved the FIELD NAME out of the shared text so the subtask
  // suggester can name its own field. Quick-add's constant must be unchanged by that —
  // the pre-split literal is pinned here so "byte-identical" is a test, not a claim.
  const COMPLEXITY_RUBRIC_PRE_SPLIT =
    'Set isComplex true when finishing the task takes several distinct steps that a person ' +
    'would want written out — planning a trip, organising an event, moving house, running ' +
    'a project, anything spanning days or involving several people. Verbs like plan, ' +
    'organise, launch, prepare, research, or build usually mean true. ' +
    'Set it false for anything done in one sitting: a call, an email, an errand, a payment, ' +
    'a single chore. ' +
    'Examples: "Plan a trip to Japan" → true; "Organize the team offsite" → true; ' +
    '"Research and launch the pricing page" → true; "Call the dentist" → false; ' +
    '"Pay the electricity bill" → false.';

  it('composes quick-add\'s rubric byte-identically to its pre-split value', () => {
    expect(COMPLEXITY_RUBRIC).toBe(`Set isComplex true when ${COMPLEXITY_DEFINITION}`);
    expect(COMPLEXITY_RUBRIC).toBe(COMPLEXITY_RUBRIC_PRE_SPLIT);
  });

  it('keeps the shared definition field-neutral', () => {
    // A field name in here would be pasted into a prompt whose schema has no such key —
    // and a 3B model ignores instructions no schema field backs (agents/subtasks.ts).
    expect(COMPLEXITY_DEFINITION).not.toMatch(/isComplex|isBreakdownUseful/);
    expect(COMPLEXITY_DEFINITION.startsWith('finishing the task')).toBe(true);
  });

  it('defines each direction the owner actually has', () => {
    const g = directionGuide(['work', 'home', 'community']);
    expect(g).toMatch(/job\/professional/i);
    expect(g).toMatch(/household, and family/i);
    expect(g).toMatch(/volunteering/i);
  });

  it('degrades to no guidance for unrecognised direction names', () => {
    // A renamed axis must not get Work/Home/Community definitions attached to it.
    expect(directionGuide(['alpha', 'beta'])).toBe('');
  });
});

// ── isTimeOfDay guard ────────────────────────────────────────────────────────

describe('isTimeOfDay', () => {
  it('accepts the four bands and nothing else', () => {
    for (const v of ['morning', 'afternoon', 'evening', 'any']) expect(isTimeOfDay(v)).toBe(true);
    for (const v of ['Morning', 'night', '', '09:00', null, 3, {}]) expect(isTimeOfDay(v)).toBe(false);
  });
});

// ── mergeEnrichment — the new fields ─────────────────────────────────────────

describe('mergeEnrichment · timeOfDay (D3)', () => {
  it('takes a band when the entry stated no clock time', () => {
    const r = mergeEnrichment(base(), { timeOfDay: 'morning' }, VOCAB);
    expect(r.timeOfDay).toBe('morning');
  });

  it('drops the band when the parser already found a clock time', () => {
    // "standup at 9" — a band on top of an explicit time is noise at best.
    const r = mergeEnrichment(base({ taskTime: '09:00' }), { timeOfDay: 'evening' }, VOCAB);
    expect(r.timeOfDay).toBeUndefined();
    expect(r.taskTime).toBe('09:00'); // the parser's time is untouched
  });

  it('drops "any" — it carries no information', () => {
    expect(mergeEnrichment(base(), { timeOfDay: 'any' }, VOCAB).timeOfDay).toBeUndefined();
  });

  it('drops a band that is not one of the four', () => {
    expect(mergeEnrichment(base(), { timeOfDay: 'lunchtime' }, VOCAB).timeOfDay).toBeUndefined();
  });

  it('never writes taskTime from a band (that would hard-pin via the AD1 pin pass)', () => {
    const r = mergeEnrichment(base(), { timeOfDay: 'morning' }, VOCAB);
    expect(r.taskTime).toBeUndefined();
  });

  it('keeps the reason only alongside a surviving band, capped', () => {
    const withBand = mergeEnrichment(base(), { timeOfDay: 'evening', timeOfDayReason: 'family time' }, VOCAB);
    expect(withBand.timeOfDayReason).toBe('family time');
    // No band survived → no orphan reason.
    const noBand = mergeEnrichment(base(), { timeOfDay: 'any', timeOfDayReason: 'whenever' }, VOCAB);
    expect(noBand.timeOfDayReason).toBeUndefined();
    const long = mergeEnrichment(base(), { timeOfDay: 'morning', timeOfDayReason: 'x'.repeat(400) }, VOCAB);
    expect(long.timeOfDayReason!.length).toBe(120);
  });
});

// ── titleSuggestsComplex — the rubric's verb rule, enforced in code ──────────
// These pin the two LIVE misses: llama3.2 returned isComplex:false for both titles even
// with the verb rule in the prompt. The heuristic makes them structurally impossible.

describe('titleSuggestsComplex', () => {
  it('catches the measured model misses', () => {
    expect(titleSuggestsComplex('Organize the team offsite')).toBe(true);
    expect(titleSuggestsComplex('Research and launch the new pricing page')).toBe(true);
    expect(titleSuggestsComplex('Plan a week-long trip to Japan')).toBe(true);
    // Round 2: every verb the rubric names is in the code twin (this one was missing).
    expect(titleSuggestsComplex('Prepare the annual budget review for the department')).toBe(true);
  });

  it('covers the rubric\'s "moving house" example as lead phrases, not a bare verb', () => {
    expect(titleSuggestsComplex('Move house at the end of the month')).toBe(true);
    expect(titleSuggestsComplex('Move out by the 15th')).toBe(true);
    expect(titleSuggestsComplex('Move the couch to the garage')).toBe(false); // one action
  });

  it('requires a real undertaking, not a bare verb-object pair', () => {
    expect(titleSuggestsComplex('Plan dinner')).toBe(false);
    expect(titleSuggestsComplex('Organize desk')).toBe(false);
  });

  it('ignores strong verbs that are not in lead position', () => {
    // "the plan" / mid-sentence verbs are nouns or subordinate — not a planning intent.
    expect(titleSuggestsComplex('Review the plan for the offsite')).toBe(false);
    expect(titleSuggestsComplex('Email Sam about the launch')).toBe(false);
  });

  it('leaves ordinary single actions alone', () => {
    expect(titleSuggestsComplex('Call the dentist')).toBe(false);
    expect(titleSuggestsComplex('Pay the electricity bill')).toBe(false);
    expect(titleSuggestsComplex('Send email to Rek')).toBe(false);
  });

  it('is case-insensitive and tolerant of punctuation', () => {
    expect(titleSuggestsComplex('PLAN a big launch party!')).toBe(true);
    expect(titleSuggestsComplex('')).toBe(false);
  });

  // rubric.ts's stated invariant, as a test: every verb the PROMPT names must also be in
  // the code twin's COMPLEX_LEAD_VERBS. The verb sentence now reaches both call sites via
  // COMPLEXITY_DEFINITION, so a retune that adds a verb to the prompt and forgets the set
  // fails here instead of silently costing recall — how "prepare" was missed the first time.
  it('backs every verb the prompt names with the code twin', () => {
    const sentence = /Verbs like ([^.]+?) usually mean true/.exec(COMPLEXITY_DEFINITION);
    expect(sentence, 'the verb sentence is gone from the shared definition').toBeTruthy();
    const verbs = sentence![1].split(',').map((v) => v.replace(/^\s*or\s+/, '').trim()).filter(Boolean);
    expect(verbs.length).toBeGreaterThan(3);
    for (const v of verbs) {
      expect(titleSuggestsComplex(`${v} the annual company retreat`), `verb "${v}"`).toBe(true);
    }
  });
});

// ── The subtask suggester's composed prompt (llm-9) ──────────────────────────
// One definition, two field names. These pin the split: the shared body must arrive
// verbatim, and the field name must stay the caller's — a borrowed "isComplex" sentence
// would instruct the model to set a key its schema does not have, which llama3.2-3B
// ignores, taking the refusal gate with it (agents/subtasks.ts:25-31).

describe('suggestSubtasks · prompt', () => {
  it('asks for isBreakdownUseful using the shared definition, never isComplex', async () => {
    prompts.length = 0;
    await suggestSubtasks('Plan a trip to Japan');
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt).toContain(`isBreakdownUseful is true when ${COMPLEXITY_DEFINITION}`);
    expect(prompt).not.toContain('isComplex');
    expect(prompt).toContain('"isBreakdownUseful": <true|false>');
  });

  it('honours the boolean refusal — a false verdict yields no chips', async () => {
    expect(await suggestSubtasks('Call the dentist')).toEqual([]);
  });
});

describe('mergeEnrichment · isComplex (D5)', () => {
  it('passes a true flag through', () => {
    expect(mergeEnrichment(base(), { isComplex: true }, VOCAB).isComplex).toBe(true);
  });

  it('treats false / missing / truthy-but-not-true as not complex', () => {
    for (const v of [false, undefined, 'yes', 1]) {
      expect(mergeEnrichment(base(), { isComplex: v }, VOCAB).isComplex).toBeUndefined();
    }
  });

  it('ORs in the verb heuristic — a model false cannot lose an obvious planning title', () => {
    const parsed = base({ title: 'Organize the team offsite' });
    expect(mergeEnrichment(parsed, { isComplex: false }, VOCAB).isComplex).toBe(true);
    expect(mergeEnrichment(parsed, {}, VOCAB).isComplex).toBe(true);
  });

  it('the heuristic never fires on a plain title', () => {
    expect(mergeEnrichment(base({ title: 'Call the dentist' }), { isComplex: false }, VOCAB).isComplex).toBeUndefined();
  });
});

describe('mergeEnrichment · priority is still bounds-checked', () => {
  it('accepts 1-4 and rejects out-of-range', () => {
    expect(mergeEnrichment(base(), { priority: 1 }, VOCAB).priority).toBe(1);
    expect(mergeEnrichment(base(), { priority: 4 }, VOCAB).priority).toBe(4);
    expect(mergeEnrichment(base(), { priority: 0 }, VOCAB).priority).toBeUndefined();
    expect(mergeEnrichment(base(), { priority: 9 }, VOCAB).priority).toBeUndefined();
  });

  it('never overrides a priority the parse already carried', () => {
    expect(mergeEnrichment(base({ priority: 2 }), { priority: 1 }, VOCAB).priority).toBe(2);
  });
});
