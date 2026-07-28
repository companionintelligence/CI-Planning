import { describe, it, expect } from 'vitest';
import { mergeEnrichment } from '../src/agents/quickadd.js';
import type { ParsedQuick } from '../src/engine/quickadd.js';
import {
  directionGuide, isTimeOfDay,
  PRIORITY_RUBRIC, DURATION_RUBRIC, TIME_OF_DAY_RUBRIC, COMPLEXITY_RUBRIC,
} from '../src/agents/rubric.js';

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

describe('mergeEnrichment · isComplex (D5)', () => {
  it('passes a true flag through', () => {
    expect(mergeEnrichment(base(), { isComplex: true }, VOCAB).isComplex).toBe(true);
  });

  it('treats false / missing / truthy-but-not-true as not complex', () => {
    for (const v of [false, undefined, 'yes', 1]) {
      expect(mergeEnrichment(base(), { isComplex: v }, VOCAB).isComplex).toBeUndefined();
    }
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
