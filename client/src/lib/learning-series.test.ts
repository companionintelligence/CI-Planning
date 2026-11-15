import { describe, it, expect } from 'vitest';
import type {
  ClassificationAccuracyResponse,
  ClassificationAccuracyRun,
  DismissalTrendResponse,
  DismissalTrendRow,
  PlacementSurvivalResponse,
  PlacementSurvivalRun,
  PlanLoopTrendResponse,
  PlanLoopTrendRun,
} from './api.js';
import {
  classificationSeries,
  dismissalSeries,
  placementSeries,
  planLoopSeries,
  dayNumber,
  daysBetween,
  ageInDays,
  describeAge,
  isStale,
} from './learning-series.js';
import { readingValue } from './learning-stats.js';

// Dates for four weekly Monday passes, oldest first.
const D = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'] as const;

const cls = (field: 'category' | 'motivation', computed_date: string, held_out: number, correct: number, accuracy: number | null): ClassificationAccuracyRun =>
  ({ field, computed_date, held_out, correct, accuracy });
const dis = (computed_date: string, decided: number, dismissed: number, rate: number | null, over: Partial<DismissalTrendRow> = {}): DismissalTrendRow =>
  ({ computed_date, period_days: 7, created: 99, decided, dismissed, rate, exemplars: 0, hinted: 0, ...over });
const plc = (computed_date: string, decided: number, accepted: number, survival_rate: number | null, over: Partial<PlacementSurvivalRun> = {}): PlacementSurvivalRun =>
  ({ computed_date, period_days: 28, decided, accepted, corrected: decided - accepted, survival_rate, keys_learned: 0, biased: 0, ...over });
const pl = (stage: string, computed_date: string, runs: number, passed: number, pass_rate: number | null, over: Partial<PlanLoopTrendRun> = {}): PlanLoopTrendRun =>
  ({ stage, computed_date, period_days: 7, runs, passed, escaped: runs - passed, first_try_pass: 0, avg_iterations: 1.5, pass_rate, ...over });

const dates = (rs: { date: string }[]) => rs.map((r) => r.date);

describe('classificationSeries', () => {
  const wire: ClassificationAccuracyResponse = {
    fields: ['category', 'motivation'],
    // NEWEST first, then field, as the server sends it.
    runs: [
      cls('category', D[3], 4, 3, 0.75),
      cls('motivation', D[3], 12, 9, 0.75),
      cls('category', D[2], 0, 0, null),
      cls('motivation', D[2], 5, 0, 0),
      cls('category', D[1], 2, 1, 0.5),
    ],
  };

  it('returns both fields in `fields` order, each ascending by date', () => {
    const s = classificationSeries(wire);
    expect(s.map((x) => x.field)).toEqual(['category', 'motivation']);
    expect(dates(s[0].readings)).toEqual([D[1], D[2], D[3]]);
    expect(dates(s[1].readings)).toEqual([D[2], D[3]]);
  });

  it('maps held_out to n and correct to hits, and never merges the fields', () => {
    const [cat, mot] = classificationSeries(wire);
    expect(cat.readings.at(-1)).toMatchObject({ n: 4, hits: 3, measured: true, periodDays: 90, extra: {} });
    expect(mot.readings.at(-1)).toMatchObject({ n: 12, hits: 9, measured: true });
    expect(cat.readings.length + mot.readings.length).toBe(wire.runs.length);
  });

  it('keeps a null accuracy as "not measured" (counts kept) and a real zero as measured', () => {
    const [cat, mot] = classificationSeries(wire);
    const nullWeek = cat.readings.find((r) => r.date === D[2])!;
    expect(nullWeek).toMatchObject({ measured: false, n: 0, hits: 0 });
    expect(readingValue(nullWeek)).toBeNull();
    const zeroWeek = mot.readings.find((r) => r.date === D[2])!;
    expect(zeroWeek).toMatchObject({ measured: true, n: 5, hits: 0 });
    expect(readingValue(zeroWeek)).toBe(0);
  });

  it('returns a field with no rows as an empty series, in `fields` order', () => {
    const onlyCategory: ClassificationAccuracyResponse = { fields: ['category', 'motivation'], runs: [cls('category', D[3], 4, 3, 0.75)] };
    const s = classificationSeries(onlyCategory);
    expect(s.map((x) => x.field)).toEqual(['category', 'motivation']);
    expect(s[0].readings).toHaveLength(1);
    expect(s[1].readings).toEqual([]);
  });

  it('returns both fields empty when there are no rows at all', () => {
    const s = classificationSeries({ fields: ['category', 'motivation'], runs: [] });
    expect(s).toEqual([
      { field: 'category', readings: [] },
      { field: 'motivation', readings: [] },
    ]);
  });

  it('appends an unknown field after the known ones, alphabetically', () => {
    const res = {
      fields: ['category', 'motivation'],
      runs: [
        { ...cls('category', D[3], 4, 3, 0.75) },
        { ...cls('motivation', D[3], 4, 3, 0.75), field: 'zeta' },
        { ...cls('motivation', D[3], 4, 3, 0.75), field: 'alpha' },
      ],
    } as unknown as ClassificationAccuracyResponse;
    expect(classificationSeries(res).map((x) => x.field)).toEqual(['category', 'motivation', 'alpha', 'zeta']);
  });

  it('gives the same series for newest-first, oldest-first and shuffled rows', () => {
    const asc = classificationSeries({ ...wire, runs: [...wire.runs].reverse() });
    const shuffled = classificationSeries({ ...wire, runs: [wire.runs[2], wire.runs[4], wire.runs[0], wire.runs[3], wire.runs[1]] });
    const base = classificationSeries(wire);
    expect(asc).toEqual(base);
    expect(shuffled).toEqual(base);
  });
});

describe('dismissalSeries', () => {
  // OLDEST first: the only endpoint that sends it this way.
  const wire: DismissalTrendResponse = {
    trend: [
      dis(D[0], 6, 4, 0.667, { hinted: 0, exemplars: 0 }),
      dis(D[1], 0, 0, null),
      dis(D[2], 14, 5, 0.357, { hinted: 1, exemplars: 5 }),
      dis(D[3], 12, 0, 0, { hinted: 1, exemplars: 23 }),
    ],
  };

  it('is ascending from an oldest-first wire, and from a newest-first or shuffled one', () => {
    const base = dismissalSeries(wire);
    expect(dates(base)).toEqual([...D]);
    expect(dismissalSeries({ trend: [...wire.trend].reverse() })).toEqual(base);
    expect(dismissalSeries({ trend: [wire.trend[2], wire.trend[0], wire.trend[3], wire.trend[1]] })).toEqual(base);
  });

  it('maps decided to n, dismissed to hits, hinted to influence, and exemplars to extra', () => {
    const s = dismissalSeries(wire);
    expect(s[2]).toMatchObject({ date: D[2], n: 14, hits: 5, measured: true, influence: 1, periodDays: 7, extra: { exemplars: 5 } });
    expect(s[0]).toMatchObject({ influence: 0, extra: { exemplars: 0 } });
  });

  it('a recorded week with nothing decided is not measured and keeps its counts', () => {
    const s = dismissalSeries(wire);
    expect(s[1]).toMatchObject({ date: D[1], measured: false, n: 0, hits: 0 });
    expect(readingValue(s[1])).toBeNull();
  });

  it('a real zero (dismissed 0 of 12) stays measured with value 0', () => {
    const s = dismissalSeries(wire);
    expect(s[3]).toMatchObject({ measured: true, n: 12, hits: 0 });
    expect(readingValue(s[3])).toBe(0);
  });

  it('drops `created` on purpose: it is nowhere in the output', () => {
    const s = dismissalSeries(wire);
    expect(JSON.stringify(s)).not.toContain('created');
    expect(JSON.stringify(s)).not.toContain('99');
    for (const r of s) expect(Object.keys(r.extra)).toEqual(['exemplars']);
  });

  it('uses the wire period_days, and falls back to 7 when it is missing', () => {
    expect(dismissalSeries({ trend: [dis(D[0], 3, 1, 0.33, { period_days: 14 })] })[0].periodDays).toBe(14);
    const bad = { trend: [{ ...dis(D[0], 3, 1, 0.33), period_days: null }] } as unknown as DismissalTrendResponse;
    expect(dismissalSeries(bad)[0].periodDays).toBe(7);
  });
});

describe('placementSeries', () => {
  // NEWEST first.
  const wire: PlacementSurvivalResponse = {
    runs: [
      plc(D[3], 28, 20, 0.714, { keys_learned: 2, biased: 1 }),
      plc(D[2], 0, 0, null),
      plc(D[1], 7, 5, 0.714),
      plc(D[0], 12, 0, 0),
    ],
  };

  it('is ascending from a newest-first wire, and from an oldest-first or shuffled one', () => {
    const base = placementSeries(wire);
    expect(dates(base)).toEqual([...D]);
    expect(placementSeries({ runs: [...wire.runs].reverse() })).toEqual(base);
    expect(placementSeries({ runs: [wire.runs[1], wire.runs[3], wire.runs[0], wire.runs[2]] })).toEqual(base);
  });

  it('maps decided to n, accepted to hits, biased to influence, and keeps corrected and keys_learned', () => {
    const last = placementSeries(wire).at(-1)!;
    expect(last).toMatchObject({ n: 28, hits: 20, measured: true, influence: 1, periodDays: 28, extra: { corrected: 8, keys_learned: 2 } });
  });

  it('keeps null as not measured and a real zero as measured', () => {
    const s = placementSeries(wire);
    expect(s[2]).toMatchObject({ date: D[2], measured: false, n: 0 });
    expect(readingValue(s[2])).toBeNull();
    expect(s[0]).toMatchObject({ measured: true, n: 12, hits: 0 });
    expect(readingValue(s[0])).toBe(0);
  });
});

describe('planLoopSeries', () => {
  // NEWEST first, then stage.
  const wire: PlanLoopTrendResponse = {
    runs: [
      pl('draft', D[3], 3, 3, 1),
      pl('order', D[3], 15, 12, 0.8, { first_try_pass: 9, avg_iterations: 1.6 }),
      pl('order', D[1], 7, 5, 0.714, { first_try_pass: 3 }),
      pl('order', D[0], 2, 1, 0.5),
    ],
  };

  it('groups by stage, alphabetical, each ascending by date', () => {
    const s = planLoopSeries(wire);
    expect(s.map((x) => x.stage)).toEqual(['draft', 'order']);
    expect(dates(s[0].readings)).toEqual([D[3]]);
    expect(dates(s[1].readings)).toEqual([D[0], D[1], D[3]]);
  });

  it('keeps an unknown stage under its raw name', () => {
    const res = { runs: [{ ...pl('order', D[3], 5, 4, 0.8), stage: 'Some Stage' }] } as PlanLoopTrendResponse;
    expect(planLoopSeries(res).map((x) => x.stage)).toEqual(['Some Stage']);
  });

  it('maps runs to n and passed to hits, and carries escaped, first_try_pass and avg_iterations', () => {
    const last = planLoopSeries(wire)[1].readings.at(-1)!;
    expect(last).toMatchObject({
      n: 15,
      hits: 12,
      measured: true,
      periodDays: 7,
      extra: { escaped: 3, first_try_pass: 9, avg_iterations: 1.6 },
    });
    expect(last.influence).toBeUndefined();
  });

  it('keeps a null avg_iterations as null, never 0', () => {
    const res: PlanLoopTrendResponse = { runs: [pl('order', D[3], 5, 4, 0.8, { avg_iterations: null })] };
    expect(planLoopSeries(res)[0].readings[0].extra.avg_iterations).toBeNull();
  });

  it('a defensive null pass_rate is not measured', () => {
    const res: PlanLoopTrendResponse = { runs: [pl('order', D[3], 0, 0, null, { avg_iterations: null })] };
    const r = planLoopSeries(res)[0].readings[0];
    expect(r).toMatchObject({ measured: false, n: 0 });
    expect(readingValue(r)).toBeNull();
  });

  it('passed plus escaped equals runs in the carried counts', () => {
    for (const s of planLoopSeries(wire)) {
      for (const r of s.readings) expect(r.hits + (r.extra.escaped as number)).toBe(r.n);
    }
  });

  it('is empty for no rows, and gives the same series for any wire order', () => {
    expect(planLoopSeries({ runs: [] })).toEqual([]);
    expect(planLoopSeries({ runs: [...wire.runs].reverse() })).toEqual(planLoopSeries(wire));
  });
});

describe('the measured rule', () => {
  const one = (rate: unknown, held_out: number, correct: number) =>
    classificationSeries({
      fields: ['category'],
      runs: [{ field: 'category', computed_date: D[3], held_out, correct, accuracy: rate as number | null }],
    })[0].readings[0];

  it('wire rate null is not measured and keeps n', () => {
    expect(one(null, 4, 3)).toMatchObject({ measured: false, n: 4, hits: 3 });
  });

  it('rate 0 with n 12 stays measured with value 0', () => {
    const r = one(0, 12, 0);
    expect(r.measured).toBe(true);
    expect(readingValue(r)).toBe(0);
  });

  it('a non-null rate with n 0 is not measured', () => {
    expect(one(0.5, 0, 0).measured).toBe(false);
    expect(one(0, 0, 0).measured).toBe(false);
  });

  it('a rate outside 0..1, or NaN, or Infinity is not measured', () => {
    expect(one(1.2, 4, 3).measured).toBe(false);
    expect(one(-0.1, 4, 3).measured).toBe(false);
    expect(one(NaN, 4, 3).measured).toBe(false);
    expect(one(Infinity, 4, 3).measured).toBe(false);
    expect(one('0.75', 4, 3).measured).toBe(false);
  });

  it('more hits than cases is not measured', () => {
    expect(one(0.75, 4, 5).measured).toBe(false);
  });

  it('negative or non-numeric counts are not measured, and never become a number', () => {
    expect(one(0.5, -2, 1).measured).toBe(false);
    expect(one(0.5, 4, -1).measured).toBe(false);
    const garbage = classificationSeries({
      fields: ['category'],
      runs: [{ field: 'category', computed_date: D[3], held_out: null, correct: undefined, accuracy: 0.5 } as unknown as ClassificationAccuracyRun],
    })[0].readings[0];
    expect(garbage).toMatchObject({ measured: false, n: 0, hits: 0 });
  });
});

describe('defensive cases', () => {
  it('drops rows with an unparseable date, in every normaliser', () => {
    const bad = ['', 'garbage', '2026-02-31', null as unknown as string];
    expect(dismissalSeries({ trend: [...bad.map((d) => dis(d, 3, 1, 0.3)), dis(D[3], 3, 1, 0.3)] })).toHaveLength(1);
    expect(placementSeries({ runs: [...bad.map((d) => plc(d, 3, 1, 0.3)), plc(D[3], 3, 1, 0.3)] })).toHaveLength(1);
    expect(planLoopSeries({ runs: [...bad.map((d) => pl('order', d, 3, 1, 0.3)), pl('order', D[3], 3, 1, 0.3)] })[0].readings).toHaveLength(1);
    expect(
      classificationSeries({ fields: ['category'], runs: [...bad.map((d) => cls('category', d, 3, 1, 0.3)), cls('category', D[3], 3, 1, 0.3)] })[0].readings,
    ).toHaveLength(1);
  });

  it('when two rows share a date for the same field or stage, the last wins', () => {
    const s = dismissalSeries({ trend: [dis(D[3], 3, 1, 0.33), dis(D[3], 10, 4, 0.4)] });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ n: 10, hits: 4 });
    // ...but the same date for two DIFFERENT fields is not a clash.
    const c = classificationSeries({ fields: ['category', 'motivation'], runs: [cls('category', D[3], 3, 1, 0.3), cls('motivation', D[3], 5, 2, 0.4)] });
    expect(c[0].readings).toHaveLength(1);
    expect(c[1].readings).toHaveLength(1);
  });

  it('tolerates an empty or malformed response without throwing', () => {
    expect(dismissalSeries({} as DismissalTrendResponse)).toEqual([]);
    expect(placementSeries({} as PlacementSurvivalResponse)).toEqual([]);
    expect(planLoopSeries({} as PlanLoopTrendResponse)).toEqual([]);
    expect(classificationSeries({} as ClassificationAccuracyResponse)).toEqual([]);
  });

  it('a hinted or biased flag that is not exactly 1 is read as 0 or 1, never passed through', () => {
    const odd = { trend: [{ ...dis(D[3], 3, 1, 0.33), hinted: true }] } as unknown as DismissalTrendResponse;
    expect(dismissalSeries(odd)[0].influence).toBe(1);
    const zero = { trend: [{ ...dis(D[3], 3, 1, 0.33), hinted: null }] } as unknown as DismissalTrendResponse;
    expect(dismissalSeries(zero)[0].influence).toBe(0);
  });
});

describe('date helpers (TZ pinned to America/Los_Angeles by the unit project)', () => {
  it('daysBetween spans the US DST end on 2026-11-01', () => {
    // A millisecond difference would be 8 days + 1 hour here.
    expect(daysBetween('2026-10-25', '2026-11-02')).toBe(8);
    expect(daysBetween('2026-11-02', '2026-10-25')).toBe(-8);
    expect(daysBetween('2026-10-26', '2026-10-26')).toBe(0);
    expect(dayNumber('2026-11-01')! - dayNumber('2026-10-31')!).toBe(1);
  });

  it('ageInDays compares calendar dates against the local today', () => {
    expect(ageInDays('2026-10-26', new Date(2026, 9, 26, 9, 0))).toBe(0);
    expect(ageInDays('2026-10-26', new Date(2026, 9, 27, 0, 30))).toBe(1);
    expect(ageInDays('2026-10-26', new Date(2026, 9, 29, 15, 0))).toBe(3);
    // Across the DST end: Nov 2 at 00:05 local is 8 calendar days after Oct 25.
    expect(ageInDays('2026-10-25', new Date(2026, 10, 2, 0, 5))).toBe(8);
  });

  it('ageInDays is not a day out late in the evening (a new Date("YYYY-MM-DD") version would be)', () => {
    // 20:00 Pacific on Oct 26 is already Oct 27 in UTC. UTC-midnight parsing would say 1.
    expect(ageInDays('2026-10-26', new Date(2026, 9, 26, 20, 0))).toBe(0);
    expect(describeAge(ageInDays('2026-10-26', new Date(2026, 9, 26, 20, 0)))).toBe('today');
  });

  it('ageInDays is NaN for an unreadable date', () => {
    expect(ageInDays('nope', new Date(2026, 9, 26))).toBeNaN();
  });

  it('describeAge: today, yesterday, N days ago, and a future date reads as today', () => {
    expect(describeAge(0)).toBe('today');
    expect(describeAge(1)).toBe('yesterday');
    expect(describeAge(2)).toBe('2 days ago');
    expect(describeAge(3)).toBe('3 days ago');
    expect(describeAge(14)).toBe('14 days ago');
    expect(describeAge(-4)).toBe('today');
    expect(describeAge(ageInDays('2026-11-05', new Date(2026, 9, 26)))).toBe('today');
  });

  it('describeAge never prints NaN', () => {
    expect(describeAge(NaN)).not.toContain('NaN');
  });

  it('isStale flips at 10 days, not 9', () => {
    const at = (days: number) => new Date(2026, 9, 26 + days, 12, 0);
    expect(isStale('2026-10-26', at(0))).toBe(false);
    expect(isStale('2026-10-26', at(8))).toBe(false);
    expect(isStale('2026-10-26', at(9))).toBe(false);
    expect(isStale('2026-10-26', at(10))).toBe(true);
    expect(isStale('2026-10-26', at(15))).toBe(true);
  });

  it('isStale does not call an unreadable date stale', () => {
    expect(isStale('nope', new Date(2026, 9, 26))).toBe(false);
  });
});
