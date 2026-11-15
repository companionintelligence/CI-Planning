import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  LEARNING_FACTS,
  COMMON,
  describeRate,
  describeComparison,
  pointLabel,
  shareCell,
  copyProblems,
} from './learning-copy.js';
import {
  MIN_N,
  BLOCK_DAYS,
  formatPct,
  formatRange,
  wilsonRange,
  type Comparison,
  type Pooled,
  type Reading,
} from './learning-stats.js';

const rd = (date: string, hits: number, n: number, over: Partial<Reading> = {}): Reading => ({
  date,
  periodDays: 7,
  n,
  hits,
  measured: n > 0,
  extra: {},
  ...over,
});

const pooled = (hits: number, n: number, over: Partial<Pooled> = {}): Pooled => ({
  hits,
  n,
  readings: 1,
  from: '2026-10-26',
  to: '2026-10-26',
  range: wilsonRange(hits, n)!,
  ...over,
});

/** 'could be 17% to 50%', generated from wilsonRange so a typed range cannot drift from the maths. */
const could = (hits: number, n: number) => `could be ${formatRange(wilsonRange(hits, n)!)}`;

/** Words that state a cause. None of them may appear in a comparison sentence. */
const CAUSE = /\b(because|caused?|due to|thanks to|led to|leads to|as a result|result of)\b/i;

describe('describeRate', () => {
  it.each([3, 9])('gives the fraction only at n = %i (under MIN_N)', (n) => {
    const d = describeRate(Math.floor(n / 2), n);
    expect(d.fraction).toBe(`${Math.floor(n / 2)} of ${n}`);
    expect(d.percent).toBeNull();
    expect(d.range).toBeNull();
  });

  it.each([
    [MIN_N, 7],
    [12, 9],
    [28, 20],
    [300, 111],
  ])('gives the percent and the range at n = %i, generated from wilsonRange', (n, hits) => {
    const d = describeRate(hits, n);
    expect(d.fraction).toBe(`${hits} of ${n}`);
    expect(d.percent).toBe(formatPct(hits, n));
    expect(d.range).toBe(formatRange(wilsonRange(hits, n)!));
    expect(d.range).toMatch(/^\d+% to \d+%$/);
  });

  it('switches exactly at MIN_N: 9 cases is a fraction, 10 is a percent', () => {
    expect(describeRate(5, MIN_N - 1).percent).toBeNull();
    expect(describeRate(5, MIN_N).percent).toBe('50%');
  });

  it('reproduces the figures the cards quote', () => {
    expect(describeRate(9, 12)).toEqual({ fraction: '9 of 12', percent: '75%', range: '46% to 92%' });
    expect(describeRate(20, 28)).toEqual({ fraction: '20 of 28', percent: '71%', range: '52% to 85%' });
    expect(describeRate(3, 4)).toEqual({ fraction: '3 of 4', percent: null, range: null });
  });

  it('prints a real zero as a count, and as 0% only at MIN_N or more', () => {
    expect(describeRate(0, 5)).toEqual({ fraction: '0 of 5', percent: null, range: null });
    const d = describeRate(0, 12);
    expect(d.fraction).toBe('0 of 12');
    expect(d.percent).toBe('0%');
    expect(d.range).toBe(formatRange(wilsonRange(0, 12)!));
    expect(d.range!.startsWith('0% to ')).toBe(true);
  });

  it('never gives a percent without a range', () => {
    for (let n = 0; n <= 60; n++) {
      for (let hits = 0; hits <= n; hits++) {
        const d = describeRate(hits, n);
        expect(d.percent === null).toBe(d.range === null);
        if (n < MIN_N) expect(d.percent).toBeNull();
      }
    }
  });

  it('gives no percent for impossible counts, even at MIN_N or more', () => {
    expect(describeRate(15, 12)).toMatchObject({ percent: null, range: null });
    expect(describeRate(-1, 12)).toMatchObject({ percent: null, range: null });
  });
});

describe('describeComparison', () => {
  const labels = { unit: 'dismissed', noun: 'decisions' };
  const cmp = (verdict: Comparison['verdict'], latest: Pooled | null, earlier: Pooled | null, anchor: string | null = '2026-10-26'): Comparison => ({
    verdict,
    anchor,
    latest,
    earlier,
  });

  it('too-few: says how many cases each period needs, in the noun the tile passes', () => {
    const c = cmp('too-few', null, null, null);
    expect(describeComparison(c, labels)).toBe(`Not enough cases to compare yet. Each ${BLOCK_DAYS}-day period needs at least ${MIN_N} decisions.`);
    expect(describeComparison(c, { unit: 'kept', noun: 'settled blocks' })).toContain('at least 10 settled blocks.');
    expect(describeComparison(c, { unit: 'kept', noun: 'settled blocks' })).toContain('Each 28-day period');
  });

  it('too-few with one side present prints the same sentence and no figures', () => {
    const text = describeComparison(cmp('too-few', pooled(4, 10), pooled(4, 9)), labels);
    expect(text).toMatch(/^Not enough cases to compare yet\./);
    expect(text).not.toMatch(/\d+%/);
  });

  it('no clear change: both sides from the counts, then the overlap sentence', () => {
    const text = describeComparison(cmp('no-clear-change', pooled(9, 29), pooled(12, 27)), labels);
    expect(text).toBe(
      `The 28 days to Oct 26 (1 reading, Oct 26): 31% dismissed (9 of 29, ${could(9, 29)}). ` +
        `The 28 days before (1 reading, Oct 26): 44% (12 of 27, ${could(12, 27)}). ` +
        'The ranges overlap, so this is no clear change. A gap this size could be chance.',
    );
    expect(text).toContain('no clear change');
  });

  it('lower: states a change and says it is not the reason', () => {
    const text = describeComparison(cmp('lower', pooled(6, 30), pooled(18, 30)), labels);
    expect(text).toBe(
      `The 28 days to Oct 26 (1 reading, Oct 26): 20% dismissed (6 of 30, ${could(6, 30)}). ` +
        `The 28 days before (1 reading, Oct 26): 60% (18 of 30, ${could(18, 30)}). ` +
        'That is lower by more than chance would explain. It shows a change, not the reason for it.',
    );
    expect(text).toContain('not the reason for it');
  });

  it('higher: the same shape with the other word', () => {
    const text = describeComparison(cmp('higher', pooled(20, 28), pooled(10, 28)), { unit: 'kept', noun: 'settled blocks' });
    expect(text).toContain(`: 71% kept (20 of 28, ${could(20, 28)}).`);
    expect(text).toContain(`: 36% (10 of 28, ${could(10, 28)}).`);
    expect(text).toContain('That is higher by more than chance would explain.');
    expect(text).toContain('not the reason for it');
  });

  it('builds its sentences from the Comparison counts, not from anything typed', () => {
    const a = describeComparison(cmp('no-clear-change', pooled(9, 29), pooled(12, 27)), labels);
    const b = describeComparison(cmp('no-clear-change', pooled(14, 40), pooled(15, 41)), labels);
    expect(a).toContain('(9 of 29, ');
    expect(a).toContain('(12 of 27, ');
    expect(b).toContain('(14 of 40, ');
    expect(b).toContain('(15 of 41, ');
    expect(b).not.toContain('(9 of 29, ');
  });

  it('uses the anchor date for the label, not today', () => {
    const text = describeComparison(cmp('no-clear-change', pooled(9, 29), pooled(12, 27), '2026-09-14'), labels);
    expect(text).toContain('The 28 days to Sep 14 (');
  });

  it('says how many readings each side pools and over which dates, so "28 days" is never claimed for less', () => {
    const latest = pooled(9, 29, { readings: 4, from: '2026-10-05', to: '2026-10-26' });
    const earlier = pooled(12, 27, { readings: 3, from: '2026-09-14', to: '2026-09-28' });
    const text = describeComparison(cmp('no-clear-change', latest, earlier), labels);
    expect(text).toContain('The 28 days to Oct 26 (4 readings, Oct 5 to Oct 26):');
    expect(text).toContain('The 28 days before (3 readings, Sep 14 to Sep 28):');
  });

  it('puts the Wilson range on both sides, taken from the pooled counts and never typed', () => {
    const text = describeComparison(cmp('no-clear-change', pooled(14, 40), pooled(15, 41)), labels);
    expect(text).toContain(`(14 of 40, ${could(14, 40)})`);
    expect(text).toContain(`(15 of 41, ${could(15, 41)})`);
  });

  it('gives both sides their range in every verdict that compares', () => {
    for (const verdict of ['no-clear-change', 'lower', 'higher'] as const) {
      const text = describeComparison(cmp(verdict, pooled(9, 29), pooled(12, 27)), labels);
      expect(text.match(/could be \d+% to \d+%/g)).toHaveLength(2);
    }
  });

  it('never mentions a cause, a good direction or a colour, in any verdict', () => {
    const all = [
      cmp('too-few', null, null, null),
      cmp('no-clear-change', pooled(9, 29), pooled(12, 27)),
      cmp('lower', pooled(6, 30), pooled(18, 30)),
      cmp('higher', pooled(18, 30), pooled(6, 30)),
    ];
    for (const c of all) {
      const text = describeComparison(c, labels);
      expect(text).not.toMatch(CAUSE);
      expect(text).not.toMatch(/\b(better|worse|good|bad|green|red|amber)\b/i);
      expect(copyProblems(text)).toEqual([]);
    }
  });

  it('degrades to the too-few sentence if a verdict claims a comparison its own data cannot back', () => {
    expect(describeComparison(cmp('lower', null, pooled(6, 30)), labels)).toMatch(/^Not enough cases/);
    expect(describeComparison(cmp('lower', pooled(6, 30), null), labels)).toMatch(/^Not enough cases/);
    expect(describeComparison(cmp('lower', pooled(6, 30), pooled(18, 30), null), labels)).toMatch(/^Not enough cases/);
  });
});

describe('pointLabel', () => {
  it('is the date and the counts below MIN_N, with no percent', () => {
    expect(pointLabel(rd('2026-10-19', 3, 4))).toBe('Oct 19: 3 of 4');
    expect(pointLabel(rd('2026-10-19', 0, 5))).toBe('Oct 19: 0 of 5');
    expect(pointLabel(rd('2026-10-19', 5, MIN_N - 1))).not.toContain('%');
  });

  it('adds the percent and its range from MIN_N cases, never the percent alone', () => {
    const label = pointLabel(rd('2026-10-19', 9, 12));
    expect(label).toBe(`Oct 19: 9 of 12 (75%, could be ${formatRange(wilsonRange(9, 12)!)})`);
    expect(label).toContain('46% to 92%');
  });

  it('says "not measured" for an unmeasured reading, whatever its counts', () => {
    expect(pointLabel(rd('2026-10-19', 0, 0, { measured: false }))).toBe('Oct 19: not measured');
    expect(pointLabel(rd('2026-10-19', 3, 12, { measured: false }))).toBe('Oct 19: not measured');
    expect(pointLabel(rd('2026-10-19', 0, 0, { measured: false }))).not.toContain('0');
  });

  it('says "not measured" for a reading that claims to be measured but has impossible counts', () => {
    expect(pointLabel(rd('2026-10-19', 5, 4, { measured: true }))).toBe('Oct 19: not measured');
    expect(pointLabel(rd('2026-10-19', 0, 0, { measured: true }))).toBe('Oct 19: not measured');
  });

  it('never emits a percent below MIN_N for any counts', () => {
    for (let n = 1; n < MIN_N; n++) {
      for (let hits = 0; hits <= n; hits++) expect(pointLabel(rd('2026-10-19', hits, n))).not.toContain('%');
    }
  });

  it('a perfect score (hits equal to n) is a score, not "not measured"', () => {
    // Perfect small weeks (1 of 1, 3 of 3, 4 of 4) are common early on, and the chart plots them at 100%.
    expect(pointLabel(rd('2026-10-19', 4, 4))).toBe('Oct 19: 4 of 4');
    expect(pointLabel(rd('2026-10-19', 1, 1))).toBe('Oct 19: 1 of 1');
    expect(pointLabel(rd('2026-10-19', MIN_N - 1, MIN_N - 1))).toBe(`Oct 19: ${MIN_N - 1} of ${MIN_N - 1}`);
    expect(pointLabel(rd('2026-10-19', 12, 12))).toBe(`Oct 19: 12 of 12 (100%, could be ${formatRange(wilsonRange(12, 12)!)})`);
    expect(pointLabel(rd('2026-10-19', MIN_N, MIN_N))).toContain('100%');
  });

  it('every pair of counts that makes sense gets a label with its counts; only impossible ones say "not measured"', () => {
    for (let n = 1; n <= 30; n++) {
      for (let hits = 0; hits <= n; hits++) {
        const label = pointLabel(rd('2026-10-19', hits, n));
        expect(label, `${hits} of ${n}`).toContain(`${hits} of ${n}`);
        expect(label, `${hits} of ${n}`).not.toContain(COMMON.notMeasured);
      }
      expect(pointLabel(rd('2026-10-19', n + 1, n))).toBe(`Oct 19: ${COMMON.notMeasured}`);
    }
  });
});

describe('shareCell', () => {
  it('is a percent at MIN_N cases or more', () => {
    expect(shareCell(rd('2026-10-19', 9, 12))).toBe('75%');
    expect(shareCell(rd('2026-10-19', 0, 12))).toBe('0%');
    expect(shareCell(rd('2026-10-19', 5, MIN_N))).toBe('50%');
  });

  it('says "under 10 cases" for a measured reading below MIN_N, built from MIN_N', () => {
    expect(shareCell(rd('2026-10-19', 3, 4))).toBe(`under ${MIN_N} cases`);
    expect(shareCell(rd('2026-10-19', 0, 5))).toBe('under 10 cases');
    expect(shareCell(rd('2026-10-19', 5, MIN_N - 1))).not.toContain('%');
  });

  it('says "not measured" for a reading that measured nothing, never 0%', () => {
    expect(shareCell(rd('2026-10-19', 0, 0, { measured: false }))).toBe('not measured');
    expect(shareCell(rd('2026-10-19', 0, 12, { measured: false }))).toBe('not measured');
    expect(shareCell(rd('2026-10-19', 5, 4, { measured: true }))).toBe('not measured');
  });

  it('says "not measured" for a reading that claims to be measured but has no cases, never "under 10 cases" or 0%', () => {
    expect(shareCell(rd('2026-10-19', 0, 0, { measured: true }))).toBe('not measured');
    expect(shareCell(rd('2026-10-19', 0, -1, { measured: true }))).toBe('not measured');
  });

  it('a perfect score (hits equal to n) is a score, not "not measured"', () => {
    expect(shareCell(rd('2026-10-19', 4, 4))).toBe('under 10 cases');
    expect(shareCell(rd('2026-10-19', 1, 1))).toBe('under 10 cases');
    expect(shareCell(rd('2026-10-19', 12, 12))).toBe('100%');
    expect(shareCell(rd('2026-10-19', MIN_N, MIN_N))).toBe('100%');
  });

  it('every pair of counts that makes sense gets a cell that is not "not measured"', () => {
    for (let n = 1; n <= 30; n++) {
      for (let hits = 0; hits <= n; hits++) expect(shareCell(rd('2026-10-19', hits, n)), `${hits} of ${n}`).not.toBe(COMMON.notMeasured);
    }
  });
});

describe('copyProblems', () => {
  it('flags an em dash and an en dash', () => {
    expect(copyProblems('one \u2014 two')).toEqual(['em dash']);
    expect(copyProblems('1\u20135')).toEqual(['en dash']);
    expect(copyProblems('a \u2014 b \u2013 c').sort()).toEqual(['em dash', 'en dash']);
  });

  it.each([
    ['improv', 'The model has improved.'],
    ['improv', 'IMPROVEMENT'],
    ['smarter', 'It is getting Smarter.'],
    ['getting better', 'Auto is Getting Better'],
    ['is working', 'The loop is working.'],
    ['the direction you want', 'It moved in the direction you want.'],
    ['proves', 'This proves the loop works.'],
    ['proves', 'Proves it'],
  ])('flags the banned wording %s in "%s"', (stem, text) => {
    expect(copyProblems(text)).toContain(stem === 'improv' ? 'improv...' : stem);
  });

  it('allows "does not prove" and the ordinary words around it', () => {
    expect(copyProblems('It cannot show that the examples helped, and it does not prove the model is right.')).toEqual([]);
    expect(copyProblems('Higher is better. Lower is better. A better week.')).toEqual([]);
    expect(copyProblems('')).toEqual([]);
  });

  it('does not flag "proves" inside another word', () => {
    expect(copyProblems('reproves')).toEqual([]);
  });
});

describe('the shared strings', () => {
  it('every COMMON string passes copyProblems', () => {
    for (const [key, value] of Object.entries(COMMON)) {
      expect(copyProblems(value), key).toEqual([]);
    }
  });

  it('builds the chart caption from MIN_N, not a typed 10', () => {
    expect(COMMON.chartCaption).toContain(`fewer than ${MIN_N} cases`);
    expect(COMMON.chartCaption).toBe(
      'Each dot is one weekly reading. A hollow dot has fewer than 10 cases behind it. ' +
        'A dashed tick means the week was checked but nothing could be measured. A break means no reading was recorded.',
    );
  });

  it('gives errors that say the fact and the fix, and never read as emptiness', () => {
    for (const msg of [COMMON.errorFailed, COMMON.errorOffline, COMMON.errorUnsupported]) {
      expect(msg).not.toMatch(/no readings yet/i);
    }
    expect(COMMON.errorFailed).toBe('Could not load these readings. Try again in a moment.');
    expect(COMMON.errorOffline).toBe('Could not reach the server. Check your connection and try again.');
    expect(COMMON.errorUnsupported).toBe('This server does not report this yet. Update the server to see it.');
  });

  it('gives clear failures that say the fact and the fix, without the sentence about loading readings', () => {
    expect(COMMON.clearFailed).toBe('Could not clear this. Try again in a moment.');
    expect(COMMON.clearOffline).toBe('Could not reach the server, so nothing was cleared. Check your connection and try again.');
    for (const msg of [COMMON.clearFailed, COMMON.clearOffline]) expect(msg).not.toMatch(/load|readings/i);
  });

  it('keeps the labels sentence case', () => {
    expect(COMMON.tryAgain).toBe('Try again');
    expect(COMMON.showReadings).toBe('Show the readings');
    expect(COMMON.moreAbout).toBe('More about this number');
    expect(COMMON.howItStarts).toBe('How it starts');
    expect(COMMON.notMeasured).toBe('not measured');
    expect(COMMON.whatItCounts).toBe('What this counts and changes');
    expect(COMMON.loaded).toBe('Readings loaded.');
  });
});

/** A server source file, read as text. The client cannot import the server, so the numbers the
 *  copy quotes are checked against the server's own declarations instead. */
const serverSource = (path: string): string =>
  readFileSync(new URL(`../../../server/src/${path}`, import.meta.url), 'utf8');

/** `export const NAME = 12;` from a server file. Fails loudly if the declaration moved. */
function serverConst(path: string, name: string): number {
  const m = new RegExp(`export const ${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*;`).exec(serverSource(path));
  if (!m) throw new Error(`export const ${name} is not a plain number in server/src/${path}; update LEARNING_FACTS and this test together`);
  return Number(m[1]);
}

/** A number inside an object literal, such as `maxIterations: 3` in agents/loop.ts DEFAULTS. */
function serverField(path: string, field: string): number {
  const m = new RegExp(`\\b${field}:\\s*(\\d+(?:\\.\\d+)?)\\b`).exec(serverSource(path));
  if (!m) throw new Error(`${field} is not a plain number in server/src/${path}; update LEARNING_FACTS and this test together`);
  return Number(m[1]);
}

describe('LEARNING_FACTS', () => {
  it('holds the server numbers the copy quotes, one place to change them', () => {
    expect(LEARNING_FACTS.classification).toEqual({ correctionFloor: 2, heldOutStride: 4, maxScored: 20, windowDays: 90, retrieveK: 3 });
    expect(LEARNING_FACTS.dismissal).toEqual({ settledFloor: 5, periodDays: 7, windowDays: 90, retrieveK: 3 });
    expect(LEARNING_FACTS.placement).toEqual({ correctionFloor: 5, periodDays: 28, windowDays: 90, maxBandHours: 6, maxExtraFragmentMinutes: 60 });
    expect(LEARNING_FACTS.planLoop).toEqual({ passMark: 0.8, maxTries: 3, judgeSamples: 3, periodDays: 7, minTasksToOrder: 2 });
  });

  // The comparison above only proves the constant equals a copy of itself. These prove it
  // equals the server, which is the drift the module's own comment warns about: a server
  // constant changes and a sentence on the Learning tab quietly becomes false.
  describe('still equals what the server declares', () => {
    const CLASSIFICATION = 'services/classification-learning.ts';
    const DISMISSAL = 'services/dismissal-learning.ts';
    const PLACEMENT = 'services/placement-learning.ts';

    it('classification', () => {
      expect(LEARNING_FACTS.classification).toEqual({
        correctionFloor: serverConst(CLASSIFICATION, 'CORRECTION_FLOOR'),
        heldOutStride: serverConst(CLASSIFICATION, 'HELD_OUT_STRIDE'),
        maxScored: serverConst(CLASSIFICATION, 'MAX_SCORED'),
        windowDays: serverConst(CLASSIFICATION, 'LEARNING_WINDOW_DAYS'),
        retrieveK: serverConst(CLASSIFICATION, 'RETRIEVE_K'),
      });
    });

    it('dismissal', () => {
      expect(LEARNING_FACTS.dismissal).toEqual({
        settledFloor: serverConst(DISMISSAL, 'DISMISSAL_FLOOR'),
        periodDays: serverConst(DISMISSAL, 'RATE_PERIOD_DAYS'),
        windowDays: serverConst(DISMISSAL, 'LEARNING_WINDOW_DAYS'),
        retrieveK: serverConst(DISMISSAL, 'RETRIEVE_K'),
      });
    });

    it('placement', () => {
      // The scheduler declares the extra-fragmentation budget in milliseconds.
      const budget = /export const MAX_FRAGMENT_COST_MS\s*=\s*(\d+)\s*\*\s*MS_PER_MIN\s*;/.exec(serverSource('engine/scheduler.ts'));
      expect(budget, 'MAX_FRAGMENT_COST_MS is no longer "<n> * MS_PER_MIN"; update LEARNING_FACTS and this test together').not.toBeNull();
      expect(LEARNING_FACTS.placement).toEqual({
        correctionFloor: serverConst(PLACEMENT, 'CORRECTION_FLOOR'),
        periodDays: serverConst(PLACEMENT, 'SURVIVAL_PERIOD_DAYS'),
        windowDays: serverConst(PLACEMENT, 'PLACEMENT_WINDOW_DAYS'),
        maxBandHours: serverConst(PLACEMENT, 'MAX_BAND_HOURS'),
        maxExtraFragmentMinutes: Number(budget![1]),
      });
    });

    it('plan loop', () => {
      // "A day needs at least 2 tasks": agents/plan.ts keeps a day with fewer deterministic.
      const floor = /if \(staged\.length < (\d+)\)/.exec(serverSource('agents/plan.ts'));
      expect(floor, 'the "staged.length < n" guard in agents/plan.ts moved; update LEARNING_FACTS and this test together').not.toBeNull();
      expect(LEARNING_FACTS.planLoop).toEqual({
        passMark: serverField('agents/loop.ts', 'passThreshold'),
        maxTries: serverField('agents/loop.ts', 'maxIterations'),
        judgeSamples: serverField('agents/loop.ts', 'judgeSamples'),
        periodDays: serverConst('services/plan-loop-learning.ts', 'STATS_WINDOW_DAYS'),
        minTasksToOrder: Number(floor![1]),
      });
    });

    it('reads real declarations, not an empty match (a regex that matches nothing would pass every case)', () => {
      expect(serverConst(CLASSIFICATION, 'CORRECTION_FLOOR')).toBeGreaterThan(0);
      expect(serverField('agents/loop.ts', 'passThreshold')).toBeGreaterThan(0);
      expect(() => serverConst(CLASSIFICATION, 'NO_SUCH_CONSTANT')).toThrow(/not a plain number/);
    });
  });

  it('sentences derived from the facts pass copyProblems', () => {
    const f = LEARNING_FACTS;
    const sentences = [
      `A field starts after ${f.classification.correctionFloor} corrections in ${f.classification.windowDays} days.`,
      `Every ${f.classification.heldOutStride}th correction is held back, up to ${f.classification.maxScored} per field.`,
      `Up to ${f.dismissal.retrieveK} past dismissals are shown to the model after ${f.dismissal.settledFloor} settled ones.`,
      `Readings cover the ${f.placement.periodDays} days before each Monday, with a ${f.placement.maxBandHours} hour spread at most.`,
      `A plan passes at ${f.planLoop.passMark} out of 1 after at most ${f.planLoop.maxTries} tries, scored ${f.planLoop.judgeSamples} times.`,
    ];
    for (const s of sentences) expect(copyProblems(s)).toEqual([]);
  });
});
