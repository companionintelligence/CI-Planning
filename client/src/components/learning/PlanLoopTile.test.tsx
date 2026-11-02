import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@solidjs/testing-library';
import type { PlanLoopTrendResponse, PlanLoopTrendRun } from '../../lib/api.js';
import type { LearningContext } from './LearningCard.js';
import { ZERO_PERCENT, textWithoutChart } from './learning-test-helpers.js';
import { COMMON, LEARNING_FACTS, copyProblems } from '../../lib/learning-copy.js';
import { layoutTrend } from '../../lib/learning-chart.js';
import { CADENCE_DAYS, LEARNING_LIMITS, MIN_N, formatRange, wilsonRange } from '../../lib/learning-stats.js';

/**
 * PlanLoopTile: the "AI day ordering checks" card.
 *
 * What these tests pin (each is behaviour, not "it renders"):
 *   1. the headline leads with counts, a percent only at MIN_N plans and then with the range
 *      the counts allow, and it is always the NEWEST reading whatever order the wire used;
 *   2. null is never a number: a row with nothing measured is a tick and the words "Not
 *      measured", a missing week is a break in the line, and avg_iterations null is "not
 *      recorded", never 0. A real zero still prints as a zero;
 *   3. this card has NO direction word, comparison, marker, stale line or reset;
 *   4. a failed fetch is an error with Try again, never "No readings yet".
 *
 * The frame (LearningCard, useReadout) is the real one: tiles render it, so this is the
 * contract the four tile files and the frame share.
 */

const trendMock = vi.fn(async (_limit?: number): Promise<PlanLoopTrendResponse> => ({ runs: [] }));
vi.mock('../../lib/api.js', () => ({
  api: {
    learning: {
      planLoopTrend: (limit?: number) => trendMock(limit),
    },
  },
}));

// The frame reaches for the toast helper through the stores barrel (ResetControl). This card
// has no reset, so nothing here should ever toast.
const toastMock = vi.fn();
vi.mock('../../stores/index.js', () => ({
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { PlanLoopTile, planLoopView, STAGE_LABEL } = await import('./PlanLoopTile.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Sunday 1 Nov 2026, local noon: 6 days after Monday 26 Oct. Noon, because the US clocks
 *  change at 2am that day and a midnight 'now' is the awkward hour. */
const NOW = new Date(2026, 10, 1, 12, 0, 0);

const ctx = (over: Partial<LearningContext> = {}): LearningContext => ({
  aiAvailable: true,
  smartMode: true,
  now: NOW,
  canReset: true,
  ...over,
});

/**
 * One wire row whose counts agree with each other (passed + escaped = runs), the way the
 * server writes them. pass_rate is derived from the counts so a fixture cannot disagree
 * with itself; pass it as null to build the defensive "nothing measured" row.
 */
const row = (
  date: string,
  runs: number,
  passed: number,
  over: Partial<PlanLoopTrendRun> = {},
): PlanLoopTrendRun => ({
  stage: 'order',
  computed_date: date,
  period_days: 7,
  runs,
  passed,
  escaped: runs - passed,
  first_try_pass: Math.min(passed, Math.ceil(passed / 2)),
  avg_iterations: 1.6,
  pass_rate: runs > 0 ? passed / runs : null,
  ...over,
});

/** The defensive row: the server never writes one, but a card that trusted that would show
 *  0% the day it did. */
const nothingMeasured = (date: string, over: Partial<PlanLoopTrendRun> = {}): PlanLoopTrendRun =>
  row(date, 0, 0, { escaped: 0, first_try_pass: 0, avg_iterations: null, pass_rate: null, ...over });

const res = (...runs: PlanLoopTrendRun[]): PlanLoopTrendResponse => ({ runs });

/** The wire sends newest first, then stage. */
const newestFirst = (runs: PlanLoopTrendRun[]) =>
  [...runs].sort((a, b) => (a.computed_date < b.computed_date ? 1 : a.computed_date > b.computed_date ? -1 : 0));

const seriesOf = (view: ReturnType<typeof planLoopView>, key = 'order') => {
  const s = view.series.find((x) => x.key === key);
  if (!s) throw new Error(`no series ${key}`);
  return s;
};

const headlineOf = (r: PlanLoopTrendResponse, c = ctx()) => planLoopView(r, c).series[0].headline ?? '';

/** All the words a view contains, for sweeps. */
const wordsIn = (v: unknown) => JSON.stringify(v);

/** "gave up" and "gives up" are the verb the copy uses for a plan that fell back to the plain
 *  order. A direction word is "up" on its own, so take the verb out before looking for one. */
const withoutGiveUp = (s: string) => s.replace(/\b(gave|gives|give|given) up\b/gi, '$1');

// ── The pure builder ─────────────────────────────────────────────────────────

describe('planLoopView: the headline', () => {
  it('under MIN_N plans leads with counts and prints no percent anywhere', () => {
    const v = planLoopView(res(row('2026-10-26', 7, 5, { first_try_pass: 3, escaped: 2, avg_iterations: 1.6 })), ctx());
    const s = seriesOf(v);
    expect(s.state).toBe('measured');
    expect(s.headline).toBe(
      'Day order: 5 of 7 plans passed the checker in the 7 days to Oct 26. ' +
        '3 passed on the first try. 2 gave up and used the plain order. Average tries per plan: 1.6.',
    );
    expect(s.detail).toBe('Latest reading: Oct 26 (6 days ago).');
    expect(wordsIn(v)).not.toContain('%'); // the chart caption, table and hover text included
  });

  it('at MIN_N plans or more adds the percent and the range the counts allow', () => {
    const range = wilsonRange(12, 15);
    expect(range).not.toBeNull();
    const s = seriesOf(
      planLoopView(res(row('2026-10-26', 15, 12, { first_try_pass: 9, escaped: 3, avg_iterations: 1.6 })), ctx()),
    );
    expect(s.headline).toBe(
      'Day order: 80% passed (12 of 15 plans) in the 7 days to Oct 26. ' +
        `With this many cases the true figure could be anywhere from ${formatRange(range!)}. ` +
        '9 passed on the first try. 3 gave up and used the plain order. Average tries per plan: 1.6.',
    );
  });

  it('switches from fraction only to percent exactly at MIN_N', () => {
    const at = (n: number) => headlineOf(res(row('2026-10-26', n, n - 2)));
    expect(at(MIN_N - 1)).not.toMatch(/%/);
    expect(at(MIN_N - 1)).toContain(`${MIN_N - 3} of ${MIN_N - 1} plans passed the checker`);
    expect(at(MIN_N)).toContain(`${MIN_N - 2} of ${MIN_N} plans)`);
    expect(at(MIN_N)).toMatch(/80% passed/);
    expect(at(MIN_N)).toContain('could be anywhere from');
  });

  it('computes the percent and range from the counts, not from the wire rate', () => {
    // 6 of 10 is 60%. The wire rate says 0.9; it is used only to detect null.
    const h = headlineOf(res(row('2026-10-26', 10, 6, { pass_rate: 0.9 })));
    expect(h).toContain('60% passed (6 of 10 plans)');
    expect(h).toContain(formatRange(wilsonRange(6, 10)!));
    expect(h).not.toContain('90%');
  });

  it('prints a real zero as a zero, under and over MIN_N', () => {
    const over = planLoopView(res(row('2026-10-26', 12, 0)), ctx());
    expect(seriesOf(over).headline).toContain('0% passed (0 of 12 plans)');
    expect(seriesOf(over).state).toBe('measured');
    const under = planLoopView(res(row('2026-10-26', 4, 0)), ctx());
    expect(seriesOf(under).headline).toContain('0 of 4 plans passed the checker');
    expect(seriesOf(under).headline).not.toContain('%');
    // A zero is a dot on the floor of the chart, not a tick.
    const layout = layoutTrend(seriesOf(under).chart!.points, { cadenceDays: CADENCE_DAYS });
    expect(layout.dots).toHaveLength(1);
    expect(layout.ticks).toHaveLength(0);
  });

  it('says "plan" for one plan', () => {
    expect(headlineOf(res(row('2026-10-26', 1, 1)))).toContain('1 of 1 plan passed the checker');
  });

  it('says passed plus gave up equals plans, for every fixture', () => {
    const fixtures: Array<[number, number]> = [[7, 5], [15, 12], [3, 3], [4, 0], [12, 0], [10, 10], [30, 17], [1, 0]];
    for (const [runs, passed] of fixtures) {
      const h = headlineOf(res(row('2026-10-26', runs, passed)));
      const counts = /(\d+) of (\d+) plans?/.exec(h);
      const gaveUp = /(\d+) gave up/.exec(h);
      expect(counts, h).not.toBeNull();
      expect(gaveUp, h).not.toBeNull();
      expect(Number(counts![1]) + Number(gaveUp![1]), h).toBe(Number(counts![2]));
      expect(Number(counts![2])).toBe(runs);
    }
  });

  it('names the span from the row period_days', () => {
    expect(headlineOf(res(row('2026-10-26', 7, 5, { period_days: 14 })))).toContain('in the 14 days to Oct 26');
    expect(headlineOf(res(row('2026-10-26', 7, 5, { period_days: 1 })))).toContain('in the 1 day to Oct 26');
  });

  it('prints "Average tries: not recorded" for a null average, never a zero', () => {
    const h = headlineOf(res(row('2026-10-26', 7, 5, { avg_iterations: null })));
    expect(h).toContain('Average tries: not recorded.');
    expect(h).not.toContain('Average tries per plan');
    expect(h).not.toMatch(/Average tries[^.]*\b0(\.0)?\b/);
  });

  it('treats an average of 0 (impossible for a finished run) as not recorded too', () => {
    expect(headlineOf(res(row('2026-10-26', 7, 5, { avg_iterations: 0 })))).toContain('Average tries: not recorded.');
  });

  it('shows one decimal for the average, including a whole number', () => {
    expect(headlineOf(res(row('2026-10-26', 7, 7, { avg_iterations: 1, escaped: 0 })))).toContain(
      'Average tries per plan: 1.0.',
    );
    expect(headlineOf(res(row('2026-10-26', 7, 5, { avg_iterations: 2.25 })))).toContain('Average tries per plan: 2.3.');
  });

  it('leaves out a "gave up" count that does not bring passed back up to the plans', () => {
    // passed 12 + gave up 5 is 17, not 15. A sentence that contradicts its own headline is
    // worse than a missing one.
    const h = headlineOf(res(row('2026-10-26', 15, 12, { escaped: 5 })));
    expect(h).toContain('(12 of 15 plans)');
    expect(h).not.toContain('gave up');
  });

  it('leaves out a first-try count above the number that passed', () => {
    const h = headlineOf(res(row('2026-10-26', 7, 5, { first_try_pass: 6 })));
    expect(h).not.toContain('first try');
    expect(h).toContain('2 gave up and used the plain order.');
  });

  it('keeps the first-try count when every pass was a first-try pass (the boundary: equal to passed)', () => {
    const h = headlineOf(res(row('2026-10-26', 5, 5, { first_try_pass: 5, escaped: 0 })));
    expect(h).toContain('5 passed on the first try.');
    // Also at the other end: none of the passes were first-try ones.
    expect(headlineOf(res(row('2026-10-26', 7, 5, { first_try_pass: 0 })))).toContain('0 passed on the first try.');
  });

  it('leaves out a negative first-try or gave-up count: a count cannot be below zero', () => {
    const negFirst = headlineOf(res(row('2026-10-26', 7, 5, { first_try_pass: -2 })));
    expect(negFirst).not.toContain('first try');
    expect(negFirst).not.toContain('-2');
    const negGaveUp = headlineOf(res(row('2026-10-26', 7, 5, { escaped: -2 })));
    expect(negGaveUp).not.toContain('gave up');
    expect(negGaveUp).not.toContain('-2');
  });

  it('is the NEWEST reading whatever order the wire used', () => {
    const rows = [row('2026-10-12', 8, 2), row('2026-10-19', 9, 9), row('2026-10-26', 7, 5), row('2026-09-28', 6, 1)];
    const expected = headlineOf(res(...newestFirst(rows)));
    expect(expected).toContain('5 of 7 plans');
    expect(expected).toContain('Oct 26');
    expect(headlineOf(res(...[...rows].reverse()))).toBe(expected);
    expect(headlineOf(res(rows[1], rows[3], rows[0], rows[2]))).toBe(expected);
  });

  it('does not present an older, better number as the current one', () => {
    const h = headlineOf(res(row('2026-10-26', 10, 3), row('2026-10-19', 10, 10)));
    expect(h).toContain('30% passed (3 of 10 plans)');
    expect(h).not.toContain('100%');
  });
});

describe('planLoopView: nothing measured is never a number', () => {
  it('a defensive null row is "not-measured", a tick, and has no percent anywhere', () => {
    const v = planLoopView(res(nothingMeasured('2026-10-26')), ctx());
    const s = seriesOf(v);
    expect(s.state).toBe('not-measured');
    expect(s.headline).toBe('Not measured: no plans were checked in the 7 days to Oct 26.');
    const layout = layoutTrend(s.chart!.points, { cadenceDays: CADENCE_DAYS });
    expect(layout.ticks).toHaveLength(1);
    expect(layout.dots).toHaveLength(0);
    expect(wordsIn(v)).not.toContain('%');
    expect(s.chart!.points[0].value).toBeNull();
    expect(s.chart!.points[0].label).toBe('Oct 26: not measured');
  });

  it('a not-measured newest row keeps the old number as a note, never as the headline', () => {
    const s = seriesOf(planLoopView(res(nothingMeasured('2026-10-26'), row('2026-10-19', 7, 5)), ctx()));
    expect(s.headline).toBe('Not measured: no plans were checked in the 7 days to Oct 26.');
    expect(s.headline).not.toContain('5 of 7');
    expect(s.notes).toEqual(['Last measured: 5 of 7 plans passed on Oct 19.']);
  });

  it('a not-measured newest row with no earlier measured row has no note', () => {
    const s = seriesOf(planLoopView(res(nothingMeasured('2026-10-26'), nothingMeasured('2026-10-19')), ctx()));
    expect(s.notes).toEqual([]);
  });

  it('a null rate with plans counted is not called "no plans were checked"', () => {
    const s = seriesOf(planLoopView(res(row('2026-10-26', 7, 5, { pass_rate: null })), ctx()));
    expect(s.state).toBe('not-measured');
    expect(s.headline).toBe('Not measured: the figures for the 7 days to Oct 26 could not be read.');
    expect(s.headline).not.toContain('no plans were checked');
  });

  it('more plans passed than were run is not measured', () => {
    const s = seriesOf(planLoopView(res(row('2026-10-26', 5, 7, { pass_rate: 1.4, escaped: 0 })), ctx()));
    expect(s.state).toBe('not-measured');
    expect(s.headline).toMatch(/^Not measured/);
  });

  it('draws a missing week as a break in the line, not a tick and not a zero', () => {
    // No row for 19 Oct at all: the server writes nothing for a week with no plans.
    const s = seriesOf(planLoopView(res(row('2026-10-26', 7, 5), row('2026-10-12', 6, 4)), ctx()));
    expect(s.chart!.points.map((p) => p.date)).toEqual(['2026-10-12', '2026-10-26']);
    expect(s.chart!.points.every((p) => p.value !== null)).toBe(true);
    const layout = layoutTrend(s.chart!.points, { cadenceDays: s.chart!.cadenceDays });
    expect(layout.ticks).toHaveLength(0);
    expect(layout.dots).toHaveLength(2);
    expect(layout.segments).toHaveLength(0); // two dots, no line between them
  });

  it('draws consecutive weeks as one line', () => {
    const s = seriesOf(
      planLoopView(res(row('2026-10-26', 7, 5), row('2026-10-19', 6, 4), row('2026-10-12', 5, 5), row('2026-10-05', 4, 3)), ctx()),
    );
    const layout = layoutTrend(s.chart!.points, { cadenceDays: s.chart!.cadenceDays });
    expect(layout.segments).toHaveLength(1);
  });

  it('marks every dot hollow under MIN_N plans and a dot at MIN_N as filled', () => {
    const s = seriesOf(planLoopView(res(row('2026-10-26', MIN_N, 8), row('2026-10-19', MIN_N - 1, 8)), ctx()));
    const layout = layoutTrend(s.chart!.points, { cadenceDays: s.chart!.cadenceDays });
    expect(layout.dots.map((d) => d.hollow)).toEqual([true, false]);
  });

  it('puts a percent in a hover label only at MIN_N plans, with its range', () => {
    const s = seriesOf(planLoopView(res(row('2026-10-26', 12, 9), row('2026-10-19', 4, 3)), ctx()));
    const [older, newer] = s.chart!.points;
    expect(older.label).toBe('Oct 19: 3 of 4');
    expect(newer.label).toContain('9 of 12');
    expect(newer.label).toContain('75%');
    expect(newer.label).toContain(formatRange(wilsonRange(9, 12)!));
  });
});

describe('planLoopView: stages', () => {
  it('gives a block per stage, labelled, each sorted by date, and never merges them', () => {
    const rows = [
      row('2026-10-26', 7, 5),
      row('2026-10-26', 4, 1, { stage: 'draft' }),
      row('2026-10-19', 6, 6, { stage: 'order', escaped: 0 }),
      row('2026-10-19', 3, 3, { stage: 'draft', escaped: 0 }),
    ];
    const v = planLoopView(res(...rows), ctx());
    expect(v.series.map((s) => s.key)).toEqual(['draft', 'order']);
    expect(v.series.map((s) => s.label)).toEqual(['draft', 'Day order']);
    expect(seriesOf(v, 'draft').headline).toMatch(/^draft: 1 of 4 plans passed the checker/);
    expect(seriesOf(v, 'order').headline).toMatch(/^Day order: 5 of 7 plans passed the checker/);
    for (const s of v.series) {
      expect(s.chart!.points.map((p) => p.date)).toEqual(['2026-10-19', '2026-10-26']);
      // The table is newest first.
      expect(s.readings!.rows.map((r) => r.key)).toEqual(['2026-10-26', '2026-10-19']);
    }
  });

  it('keeps an unknown stage under its raw name', () => {
    const v = planLoopView(res(row('2026-10-26', 7, 5, { stage: 'summarise' })), ctx());
    expect(v.series[0].key).toBe('summarise');
    expect(v.series[0].headline).toMatch(/^summarise: 5 of 7 plans/);
  });

  it('maps only the stages it knows, and not Object.prototype names', () => {
    expect(STAGE_LABEL).toEqual({ order: 'Day order' });
    const v = planLoopView(res(row('2026-10-26', 7, 5, { stage: 'constructor' })), ctx());
    expect(v.series[0].headline).toMatch(/^constructor: 5 of 7 plans/);
  });

  it('uses no sub-heading for a single stage, because the headline already names it', () => {
    expect(planLoopView(res(row('2026-10-26', 7, 5)), ctx()).series[0].label).toBeNull();
  });

  it('feeds a two-stage response in wire order (newest first, then stage) and still sorts', () => {
    const rows = newestFirst([row('2026-10-12', 5, 1), row('2026-10-19', 5, 2), row('2026-10-26', 5, 3)]);
    const s = seriesOf(planLoopView(res(...rows), ctx()));
    expect(s.chart!.points.map((p) => p.date)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    expect(s.headline).toContain('3 of 5');
  });
});

describe('planLoopView: no rows', () => {
  const EMPTY_TEXT =
    'No readings yet. A week gets a reading only if AI day ordering produced at least one plan that week. ' +
    'Nothing here means nothing was checked; it does not mean plans were bad.';

  it('gives one "none" block with the empty sentence, no chart and no table', () => {
    const v = planLoopView(res(), ctx());
    expect(v.series).toHaveLength(1);
    const s = v.series[0];
    expect(s.key).toBe('order');
    expect(s.state).toBe('none');
    expect(s.empty).toBe(EMPTY_TEXT);
    expect(s.headline).toBeNull();
    expect(s.detail).toBeNull();
    expect(s.chart).toBeNull();
    expect(s.readings).toBeNull();
    expect(v.startOpen).toBe(true);
  });

  it('treats rows whose dates cannot be read as no rows', () => {
    const v = planLoopView(res(row('not a date', 7, 5), row('2026-13-45', 7, 5)), ctx());
    expect(v.series).toHaveLength(1);
    expect(v.series[0].state).toBe('none');
  });

  it('survives a response with no runs array', () => {
    const v = planLoopView({} as PlanLoopTrendResponse, ctx());
    expect(v.series[0].state).toBe('none');
  });

  it('keeps the More-about details closed once something is measured, open otherwise', () => {
    expect(planLoopView(res(row('2026-10-26', 7, 5)), ctx()).startOpen).toBe(false);
    expect(planLoopView(res(nothingMeasured('2026-10-26')), ctx()).startOpen).toBe(true);
  });
});

describe('planLoopView: what this card does not have', () => {
  const fixtures: Record<string, PlanLoopTrendResponse> = {
    empty: res(),
    measured: res(row('2026-10-26', 7, 5), row('2026-10-19', 12, 4), row('2026-10-12', 15, 12)),
    nullRow: res(nothingMeasured('2026-10-26'), row('2026-10-19', 7, 5)),
    twoStages: res(row('2026-10-26', 7, 5), row('2026-10-26', 4, 1, { stage: 'draft' })),
    old: res(row('2026-08-03', 7, 5)),
  };

  it('has no comparison, no marker, no status line and no reset, in any state', () => {
    for (const [name, r] of Object.entries(fixtures)) {
      const v = planLoopView(r, ctx());
      expect(v.status, name).toBeNull();
      expect(v.resetAvailable, name).toBe(false);
      for (const s of v.series) {
        expect(s.comparison, name).toBeNull();
        expect(s.chart?.marker ?? null, name).toBeNull();
      }
    }
  });

  it('has no direction word: no "better", "worse", "higher is" or "lower is", no "up" or "down"', () => {
    for (const [name, r] of Object.entries(fixtures)) {
      const text = withoutGiveUp(wordsIn(planLoopView(r, ctx())));
      expect(text, name).not.toMatch(/better|worse|higher is|lower is|\bup\b|\bdown\b/i);
    }
  });

  it('never claims an improvement, a cause, or that the loop is working', () => {
    for (const [name, r] of Object.entries(fixtures)) {
      expect(copyProblems(wordsIn(planLoopView(r, ctx()))), name).toEqual([]);
    }
  });

  it('has no stale line, even for a reading months old', () => {
    const v = planLoopView(fixtures.old, ctx());
    expect(v.contextLines).toEqual([]);
    expect(wordsIn(v)).not.toContain('No new reading');
    // It does say how old the reading is.
    expect(v.series[0].detail).toBe('Latest reading: Aug 3 (90 days ago).');
  });
});

describe('planLoopView: context lines', () => {
  const r = res(row('2026-10-26', 7, 5));
  const lines = (c: Partial<LearningContext>) => planLoopView(r, ctx(c)).contextLines;

  it('says AI day ordering is off only when smartMode is exactly false', () => {
    expect(lines({ smartMode: false })).toEqual(['AI day ordering is off, so no new plans are being checked.']);
    expect(lines({ smartMode: true })).toEqual([]);
    expect(lines({ smartMode: null })).toEqual([]);
  });

  it('says the local model is unreachable only when aiAvailable is exactly false', () => {
    expect(lines({ aiAvailable: false })).toEqual([
      'Your local model is not ready right now, so no new plans are being checked.',
    ]);
    expect(lines({ aiAvailable: true })).toEqual([]);
    expect(lines({ aiAvailable: null })).toEqual([]);
  });

  it('shows both, switch first, when both are false, and neither when both are unknown', () => {
    expect(lines({ smartMode: false, aiAvailable: false })).toEqual([
      'AI day ordering is off, so no new plans are being checked.',
      'Your local model is not ready right now, so no new plans are being checked.',
    ]);
    expect(lines({ smartMode: null, aiAvailable: null })).toEqual([]);
  });

  it('shows them over an empty response too, where they explain the emptiness', () => {
    expect(planLoopView(res(), ctx({ smartMode: false })).contextLines).toHaveLength(1);
  });
});

describe('planLoopView: the chart and the table', () => {
  it('uses the weekly cadence and the Blank stretches caption, built from MIN_N', () => {
    const c = seriesOf(planLoopView(res(row('2026-10-26', 7, 5)), ctx())).chart!;
    expect(c.cadenceDays).toBe(CADENCE_DAYS);
    expect(c.caption).toContain('Blank stretches are weeks with no plans checked.');
    expect(c.caption).toContain(`fewer than ${MIN_N} plans`);
    expect(c.caption).not.toContain('dashed tick'); // none is drawn
  });

  it('explains the dashed tick only when one is drawn', () => {
    const c = seriesOf(planLoopView(res(nothingMeasured('2026-10-26'), row('2026-10-19', 7, 5)), ctx())).chart!;
    expect(c.caption).toContain('dashed tick');
  });

  it('lists the readings newest first with every cell already formatted', () => {
    const s = seriesOf(
      planLoopView(
        res(
          row('2026-10-26', 7, 5, { first_try_pass: 3, avg_iterations: 1.6 }),
          row('2026-10-19', 15, 12, { first_try_pass: 9, avg_iterations: null }),
        ),
        ctx(),
      ),
    );
    expect(s.readings!.columns).toEqual(['Date', 'Plans checked', 'Passed', 'First try', 'Gave up', 'Average tries']);
    expect(s.readings!.rows).toEqual([
      { key: '2026-10-26', cells: ['Oct 26', '7', '5', '3', '2', '1.6'] },
      { key: '2026-10-19', cells: ['Oct 19', '15', '12', '9', '3', 'not recorded'] },
    ]);
  });

  it('says "not measured" in every cell of a not-measured row that could pass for a result', () => {
    const s = seriesOf(planLoopView(res(nothingMeasured('2026-10-26')), ctx()));
    expect(s.readings!.rows[0].cells).toEqual([
      'Oct 26',
      '0',
      'not measured',
      'not measured',
      'not measured',
      'not measured',
    ]);
  });

  it('shows a count that cannot be vouched for as "not recorded", not as a number', () => {
    const s = seriesOf(planLoopView(res(row('2026-10-26', 15, 12, { escaped: 5, first_try_pass: 20 })), ctx()));
    expect(s.readings!.rows[0].cells).toEqual(['Oct 26', '15', '12', 'not recorded', 'not recorded', '1.6']);
  });
});

// ── The component, with the real frame ───────────────────────────────────────

const renderTile = (c: LearningContext = ctx()) => render(() => <PlanLoopTile context={c} />);
const card = () => screen.getByTestId('learning-card-planloop');
const settled = () => screen.findByTestId('learning-headline-planloop-order');

const statusError = (status: number, message = 'raw server text') => Object.assign(new Error(message), { status });

beforeEach(() => {
  trendMock.mockReset().mockResolvedValue({ runs: [] });
  toastMock.mockReset();
});

describe('PlanLoopTile: fetching', () => {
  it('asks for the planned number of rows, once, and nothing else', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile();
    await settled();
    expect(trendMock).toHaveBeenCalledTimes(1);
    expect(trendMock).toHaveBeenCalledWith(24);
    expect(LEARNING_LIMITS.planLoop).toBe(24);
  });

  it('shows loading, and the always-visible caveat, before the answer arrives', async () => {
    let release!: (r: PlanLoopTrendResponse) => void;
    trendMock.mockReturnValue(new Promise<PlanLoopTrendResponse>((r) => (release = r)));
    renderTile();
    expect(within(card()).getByText(COMMON.loading)).toBeInTheDocument();
    expect(screen.getByTestId('learning-primary-caveat-planloop')).toBeInTheDocument();
    expect(screen.queryByTestId('learning-headline-planloop-order')).toBeNull();
    expect(screen.queryByTestId('learning-empty-planloop-order')).toBeNull();
    release(res(row('2026-10-26', 7, 5)));
    expect(await settled()).toBeInTheDocument();
    expect(within(card()).queryByText(COMMON.loading)).toBeNull();
  });
});

describe('PlanLoopTile: ready', () => {
  it('renders the newest reading as the headline, with the age line under it', async () => {
    // Fed newest first, the way the server sends it.
    trendMock.mockResolvedValue(res(...newestFirst([row('2026-10-19', 12, 4), row('2026-10-26', 7, 5)])));
    renderTile();
    const h = await settled();
    expect(h).toHaveAttribute('data-state', 'measured');
    expect(h).toHaveTextContent(/^Day order: 5 of 7 plans passed the checker in the 7 days to Oct 26\./);
    expect(screen.getByTestId('learning-detail-planloop-order')).toHaveTextContent(
      'Latest reading: Oct 26 (6 days ago).',
    );
  });

  it('renders a chart, the caption and the readings table', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5), row('2026-10-19', 15, 12)));
    renderTile();
    await settled();
    expect(screen.getByTestId('learning-chart-planloop-order')).toBeInTheDocument();
    expect(card()).toHaveTextContent('Blank stretches are weeks with no plans checked.');
    const table = screen.getByTestId('learning-readings-planloop-order');
    expect(table).toHaveTextContent('Plans checked');
    expect(table).toHaveTextContent('Gave up');
    expect(table).toHaveTextContent('Oct 19');
  });

  it('has no comparison line and no direction wording on screen', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 12, 9), row('2026-10-19', 12, 3), row('2026-10-12', 12, 3)));
    renderTile();
    await settled();
    expect(screen.queryByTestId('learning-comparison-planloop-order')).toBeNull();
    const text = withoutGiveUp(card().textContent ?? '');
    expect(text).not.toMatch(/higher is better|lower is better|\bbetter\b|\bworse\b|\bup\b|\bdown\b/i);
    expect(text).not.toMatch(/Examples stored|Preferences stored|No new reading/);
  });

  it('draws a defensive null row as "Not measured" and never as a percent', async () => {
    trendMock.mockResolvedValue(res(nothingMeasured('2026-10-26'), row('2026-10-19', 7, 5)));
    renderTile();
    const h = await settled();
    expect(h).toHaveAttribute('data-state', 'not-measured');
    expect(h).toHaveTextContent('Not measured: no plans were checked in the 7 days to Oct 26.');
    // The chart's fixed axis prints 0%, so the sweep is over the card without it.
    expect(textWithoutChart(card())).not.toMatch(ZERO_PERCENT);
    expect(card()).toHaveTextContent('Last measured: 5 of 7 plans passed on Oct 19.');
  });

  it('shows the empty sentence, no chart and no table, and opens the "how it starts" block', async () => {
    renderTile();
    expect(await screen.findByTestId('learning-empty-planloop-order')).toHaveTextContent(
      /^No readings yet\. A week gets a reading only if AI day ordering produced at least one plan that week\./,
    );
    expect(screen.queryByTestId('learning-chart-planloop-order')).toBeNull();
    expect(screen.queryByTestId('learning-readings-planloop-order')).toBeNull();
    const more = screen.getByTestId('learning-more-planloop') as HTMLDetailsElement;
    expect(more.open).toBe(true);
    expect(more).toHaveTextContent('Turn on AI day ordering');
    expect(more).toHaveTextContent(`at least ${LEARNING_FACTS.planLoop.minTasksToOrder} tasks`);
  });

  it('keeps the "how it starts" block closed once a reading is measured', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile();
    await settled();
    expect((screen.getByTestId('learning-more-planloop') as HTMLDetailsElement).open).toBe(false);
  });

  it('shows one block per stage', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5), row('2026-10-26', 4, 1, { stage: 'draft' })));
    renderTile();
    await settled();
    expect(screen.getByTestId('learning-headline-planloop-draft')).toHaveTextContent(/^draft: 1 of 4 plans/);
    expect(screen.getByTestId('learning-headline-planloop-order')).toHaveTextContent(/^Day order: 5 of 7 plans/);
  });
});

describe('PlanLoopTile: what the card says about itself', () => {
  const F = LEARNING_FACTS.planLoop;
  const open = async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile();
    await settled();
    return {
      about: screen.getByTestId('learning-about-planloop').textContent ?? '',
      more: screen.getByTestId('learning-more-planloop'),
    };
  };

  it('what it counts: the writer, the three scores, the pass mark, the tries, and the 7-day window', async () => {
    const { about } = await open();
    expect(about).toContain('one model call writes the order and a second call scores it 3 times, and the middle score counts');
    expect(about).toContain('breaks none of the fixed rules and that score is at least 0.8 out of 1');
    expect(about).toContain('If it has not passed after 3 tries');
    expect(about).toContain('the app gives up and uses the plain rule-based order');
    expect(about).toContain('counts the plans finished in the 7 days before it');
    expect(about).toContain('plans checked, passed, passed on the first try, gave up, and average tries.');
    // Built from the facts the server test checks, so the sentences follow them.
    expect(about).toContain(`scores it ${F.judgeSamples} times`);
    expect(about).toContain(`at least ${F.passMark} out of 1`);
    expect(about).toContain(`after ${F.maxTries} tries`);
    expect(about).toContain(`in the ${F.periodDays} days before it`);
  });

  it('does not claim how many plans a typical week has: that is not known from the readings on screen', async () => {
    const { about, more } = await open();
    expect(about).not.toMatch(/handful/i);
    expect(about).not.toMatch(/most weeks/i);
    expect(more.textContent).not.toMatch(/handful|most dots/i);
  });

  it('what it changes: nothing', async () => {
    const { about } = await open();
    expect(about).toContain('This changes nothing about how plans are made. It is a readout for a person to read, and no part of it adjusts the next plan.');
  });

  it('the small-sample caveat is a rule about what is drawn, not a guess about the owner\'s weeks', async () => {
    const { more } = await open();
    const items = [...more.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(6);
    expect(items[3]).toBe(
      `A week with fewer than ${MIN_N} plans is a small sample, and is drawn as a hollow dot. One week's share can swing a lot on so few plans.`,
    );
    expect(items[3]).toContain('fewer than 10 plans');
  });

  it('lists the other caveats under "More about this number", in order', async () => {
    const { more } = await open();
    const items = [...more.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items[0]).toContain('Passing means the checker was satisfied.');
    expect(items[0]).toContain('while the prompt and the 0.8 pass mark stay the same');
    expect(items[1]).toContain('Only finished runs are counted.');
    expect(items[2]).toContain('Days planned with the plain rule-based order');
    expect(items[4]).toBe('Only the day-order step is measured today.');
    expect(items[5]).toContain('a week with no plans checked, not a bad week');
  });

  it('how it starts: the switch, the two-task minimum, and that nothing else is needed', async () => {
    const { more } = await open();
    const steps = more.textContent ?? '';
    expect(steps).toContain('Turn on AI day ordering (Settings → Preferences;');
    expect(steps).toContain('A day needs at least 2 tasks waiting to be placed before a model order is written.');
    expect(steps).toContain('Nothing else is needed and there is nothing to configure.');
  });
});

describe('PlanLoopTile: caveats', () => {
  it('always shows the model-checks-a-model caveat, above the data', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile();
    await settled();
    const caveat = screen.getByTestId('learning-primary-caveat-planloop');
    expect(caveat).toHaveTextContent('model is checking another model');
    expect(caveat).toHaveTextContent('whether you kept or changed the plan');
    expect(caveat.textContent).not.toContain('Nobody asked you');
  });

  it('says the writer and the checker can be the same model, because the tiers can be', async () => {
    renderTile();
    await screen.findByTestId('learning-empty-planloop-order');
    expect(screen.getByTestId('learning-primary-caveat-planloop')).toHaveTextContent('can be the same model');
  });

  it('puts the other caveats under "More about this number"', async () => {
    renderTile();
    await screen.findByTestId('learning-empty-planloop-order');
    const more = screen.getByTestId('learning-more-planloop');
    expect(more).toHaveTextContent(COMMON.moreAbout);
    expect(more).toHaveTextContent(`${LEARNING_FACTS.planLoop.passMark} pass mark`);
    expect(more).toHaveTextContent('A run that stopped with an error before it finished may not appear here at all.');
    expect(more).toHaveTextContent('Only the day-order step is measured today.');
    expect(more).toHaveTextContent('not a bad week');
  });
});

describe('PlanLoopTile: context lines', () => {
  it('shows the switch line only when smartMode is exactly false', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile(ctx({ smartMode: false }));
    await settled();
    const lines = screen.getAllByTestId('learning-context-planloop').map((e) => e.textContent);
    expect(lines).toEqual(['AI day ordering is off, so no new plans are being checked.']);
  });

  it('shows the model line only when aiAvailable is exactly false', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile(ctx({ aiAvailable: false }));
    await settled();
    expect(screen.getAllByTestId('learning-context-planloop').map((e) => e.textContent)).toEqual([
      'Your local model is not ready right now, so no new plans are being checked.',
    ]);
  });

  it('shows neither line for true or null', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile(ctx({ aiAvailable: null, smartMode: null }));
    await settled();
    expect(screen.queryAllByTestId('learning-context-planloop')).toHaveLength(0);
  });
});

describe('PlanLoopTile: no reset, for anyone', () => {
  it.each([
    ['an account that may clear', true],
    ['a read-only account', false],
    ['an account still being identified', null],
  ] as const)('has no clear or reset control and says there is nothing to clear: %s', async (_name, canReset) => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile(ctx({ canReset }));
    await settled();
    expect(screen.queryByRole('button', { name: /clear|reset/i })).toBeNull();
    expect(screen.queryByTestId('learning-reset-planloop')).toBeNull();
    expect(screen.queryByTestId('learning-reset-hint-planloop')).toBeNull();
    expect(card()).toHaveTextContent(
      'Nothing to clear. This readout does not change how plans are made, so there is nothing learned to remove.',
    );
    // No read-only note either: this card has nothing a viewer is being kept from.
    expect(card().textContent).not.toContain(COMMON.readOnlyNote);
  });

  it('never calls window.confirm or the toast', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile();
    await settled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('keeps every button in the card type="button"', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 7, 5)));
    renderTile();
    await settled();
    for (const b of card().querySelectorAll('button')) expect(b).toHaveAttribute('type', 'button');
  });
});

describe('PlanLoopTile: a failed fetch is an error, never emptiness', () => {
  it('shows the failure text and Try again, and never "No readings yet"', async () => {
    trendMock.mockRejectedValue(statusError(500));
    renderTile();
    const err = await screen.findByTestId('learning-error-planloop');
    expect(err).toHaveTextContent(COMMON.errorFailed);
    expect(screen.getByTestId('learning-retry-planloop')).toHaveTextContent(COMMON.tryAgain);
    expect(card().textContent).not.toContain('No readings yet');
    expect(card().textContent).not.toContain('raw server text'); // the raw message is never shown
    expect(screen.queryByTestId('learning-headline-planloop-order')).toBeNull();
    expect(screen.queryByTestId('learning-empty-planloop-order')).toBeNull();
    // The caveat does not depend on data, so it is still there.
    expect(screen.getByTestId('learning-primary-caveat-planloop')).toBeInTheDocument();
  });

  it('says it could not reach the server when offline (status 0)', async () => {
    trendMock.mockRejectedValue(statusError(0, 'Failed to fetch'));
    renderTile();
    expect(await screen.findByTestId('learning-error-planloop')).toHaveTextContent(COMMON.errorOffline);
    expect(card().textContent).not.toContain('No readings yet');
  });

  it('says the server is too old to report this on a 404', async () => {
    trendMock.mockRejectedValue(statusError(404, 'Not Found'));
    renderTile();
    expect(await screen.findByTestId('learning-error-planloop')).toHaveTextContent(COMMON.errorUnsupported);
    expect(card().textContent).not.toContain('No readings yet');
  });

  it('Try again re-calls only this loader, once, and then shows the data', async () => {
    trendMock.mockRejectedValueOnce(statusError(500)).mockResolvedValueOnce(res(row('2026-10-26', 7, 5)));
    renderTile();
    fireEvent.click(await screen.findByTestId('learning-retry-planloop'));
    expect(await settled()).toHaveTextContent('Day order: 5 of 7 plans');
    expect(trendMock).toHaveBeenCalledTimes(2);
    expect(trendMock).toHaveBeenLastCalledWith(24);
    expect(screen.queryByTestId('learning-error-planloop')).toBeNull();
  });

  it('stays an error when the retry fails too', async () => {
    trendMock.mockRejectedValue(statusError(500));
    renderTile();
    fireEvent.click(await screen.findByTestId('learning-retry-planloop'));
    await waitFor(() => expect(trendMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('learning-error-planloop')).toBeInTheDocument();
    expect(card().textContent).not.toContain('No readings yet');
  });
});

describe('PlanLoopTile: the words on screen', () => {
  const screens: Array<[string, PlanLoopTrendResponse]> = [
    ['empty', res()],
    ['measured, under MIN_N', res(row('2026-10-26', 7, 5), row('2026-10-19', 5, 4))],
    ['measured, over MIN_N', res(row('2026-10-26', 15, 12), row('2026-10-19', 12, 4))],
    ['a real zero', res(row('2026-10-26', 12, 0))],
    ['a null row', res(nothingMeasured('2026-10-26'), row('2026-10-19', 7, 5))],
  ];

  it.each(screens)('has no dash, banned wording or standalone 0% in the rendered card: %s', async (name, r) => {
    trendMock.mockResolvedValue(r);
    renderTile(ctx({ smartMode: false, aiAvailable: false }));
    await screen.findByTestId(
      name === 'empty' ? 'learning-empty-planloop-order' : 'learning-headline-planloop-order',
    );
    const text = card().textContent ?? '';
    expect(copyProblems(text)).toEqual([]);
    if (name !== 'a real zero') expect(textWithoutChart(card())).not.toMatch(ZERO_PERCENT);
  });

  it('prints the real zero as 0% (the one place a 0% is right)', async () => {
    trendMock.mockResolvedValue(res(row('2026-10-26', 12, 0)));
    renderTile();
    expect(await settled()).toHaveTextContent('0% passed (0 of 12 plans)');
  });
});
