import { describe, it, expect } from 'vitest';
import {
  MIN_N,
  BLOCK_DAYS,
  CADENCE_DAYS,
  STALE_AFTER_DAYS,
  WILSON_Z,
  LEARNING_LIMITS,
  readingValue,
  wilsonRange,
  formatPct,
  formatRange,
  nonOverlapping,
  pool,
  compareRecent,
  dayNumber,
  daysBetween,
  type Reading,
} from './learning-stats.js';
import { addDays } from './dates.js';

/** A measured reading unless n is 0 or `measured` is forced off. */
function rd(date: string, hits: number, n: number, over: Partial<Reading> = {}): Reading {
  return { date, periodDays: 7, n, hits, measured: n > 0, extra: {}, ...over };
}
const nm = (date: string): Reading => rd(date, 0, 0, { measured: false });

/** Weekly readings ending at `end`, newest last: `counts[i]` is [hits, n] for week i. */
function weekly(end: string, counts: Array<[number, number]>, over: Partial<Reading> = {}): Reading[] {
  return counts.map(([h, n], i) => rd(addDays(end, -7 * (counts.length - 1 - i)), h, n, over));
}

describe('constants', () => {
  it('pins the thresholds the rest of the panel is built on', () => {
    expect(MIN_N).toBe(10);
    expect(BLOCK_DAYS).toBe(28);
    expect(CADENCE_DAYS).toBe(7);
    expect(STALE_AFTER_DAYS).toBe(9);
    expect(WILSON_Z).toBe(1.96);
    // Rows, not weeks: classification across two fields, plan loop across stages.
    expect(LEARNING_LIMITS).toEqual({ classification: 24, dismissal: 12, placement: 12, planLoop: 24 });
  });
});

describe('dayNumber and daysBetween', () => {
  it('counts whole days since 1970-01-01', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayNumber('2026-10-26')).toBe(Date.UTC(2026, 9, 26) / 86_400_000);
  });

  it('is not shifted by the host timezone (the unit project pins America/Los_Angeles)', () => {
    // new Date('2026-10-26') is UTC midnight, which is Oct 25 in Los Angeles.
    expect(dayNumber('2026-10-26')! - dayNumber('2026-10-25')!).toBe(1);
    expect(daysBetween('2026-10-25', '2026-11-02')).toBe(8);
  });

  it('rejects things that are not calendar dates', () => {
    for (const bad of ['', 'nope', '2026-13-01', '2026-02-31', '2026-1-5', null as unknown as string]) {
      expect(dayNumber(bad)).toBeNull();
    }
    expect(daysBetween('nope', '2026-10-26')).toBeNaN();
    expect(daysBetween('2026-10-26', '')).toBeNaN();
  });

  it('reads a leading date off a longer timestamp', () => {
    expect(dayNumber('2026-10-26T04:10:00Z')).toBe(dayNumber('2026-10-26'));
  });
});

describe('readingValue', () => {
  it('is hits over n for a measured reading, including a real zero', () => {
    expect(readingValue(rd('2026-10-26', 3, 4))).toBe(0.75);
    expect(readingValue(rd('2026-10-26', 0, 12))).toBe(0);
  });

  it('is null when nothing was measured, whatever the counts say', () => {
    expect(readingValue(nm('2026-10-26'))).toBeNull();
    expect(readingValue(rd('2026-10-26', 3, 4, { measured: false }))).toBeNull();
  });

  it('is null for a reading that claims to be measured but cannot be divided', () => {
    expect(readingValue(rd('2026-10-26', 0, 0, { measured: true }))).toBeNull();
    expect(readingValue(rd('2026-10-26', 5, 4, { measured: true }))).toBeNull();
    expect(readingValue(rd('2026-10-26', -1, 4, { measured: true }))).toBeNull();
    expect(readingValue(rd('2026-10-26', NaN, 4, { measured: true }))).toBeNull();
  });
});

describe('wilsonRange', () => {
  it('matches the cases the copy quotes, after rounding outward', () => {
    expect(wilsonRange(3, 4)).toEqual({ lo: 0.3, hi: 0.96 });
    expect(wilsonRange(9, 12)).toEqual({ lo: 0.46, hi: 0.92 });
    expect(wilsonRange(20, 28)).toEqual({ lo: 0.52, hi: 0.85 });
  });

  it('formats the quoted ranges as the cards print them', () => {
    expect(formatRange(wilsonRange(9, 12)!)).toBe('46% to 92%');
    expect(formatRange(wilsonRange(20, 28)!)).toBe('52% to 85%');
    expect(formatRange(wilsonRange(3, 4)!)).toBe('30% to 96%');
  });

  it('forces the floor to 0 for no hits and the ceiling to 1 for all hits', () => {
    expect(wilsonRange(0, 12)!.lo).toBe(0);
    expect(wilsonRange(12, 12)!.hi).toBe(1);
    expect(wilsonRange(0, 12)!.hi).toBeGreaterThan(0);
    expect(wilsonRange(12, 12)!.lo).toBeLessThan(1);
  });

  it('has no range at all for an empty or impossible reading', () => {
    expect(wilsonRange(0, 0)).toBeNull();
    expect(wilsonRange(3, 0)).toBeNull();
    expect(wilsonRange(5, 4)).toBeNull();
    expect(wilsonRange(-1, 4)).toBeNull();
    expect(wilsonRange(NaN, 4)).toBeNull();
    expect(wilsonRange(1, Infinity)).toBeNull();
    expect(wilsonRange(2, -3)).toBeNull();
  });

  it('is always whole percents and never narrower than the unrounded interval', () => {
    // The unrounded bounds come from a different route than the implementation: the two
    // roots of (p_hat - p)^2 = z^2 p (1 - p) / n, a quadratic in p, rather than the closed
    // centre-plus-half-width form.
    const z2 = WILSON_Z * WILSON_Z;
    for (let n = 1; n <= 80; n++) {
      for (let hits = 0; hits <= n; hits++) {
        const ph = hits / n;
        const a = 1 + z2 / n;
        const b = -(2 * ph + z2 / n);
        const c = ph * ph;
        const disc = Math.sqrt(Math.max(0, b * b - 4 * a * c));
        const rootLo = (-b - disc) / (2 * a);
        const rootHi = (-b + disc) / (2 * a);
        const r = wilsonRange(hits, n)!;

        // Whole percents.
        expect(Math.abs(r.lo * 100 - Math.round(r.lo * 100))).toBeLessThan(1e-9);
        expect(Math.abs(r.hi * 100 - Math.round(r.hi * 100))).toBeLessThan(1e-9);
        // Never narrower than the maths (1e-9 tolerance).
        expect(r.lo).toBeLessThanOrEqual(rootLo + 1e-9);
        expect(r.hi).toBeGreaterThanOrEqual(rootHi - 1e-9);
        // Not wider than one percentage point per side.
        expect(r.lo).toBeGreaterThan(rootLo - 0.01 - 1e-9);
        expect(r.hi).toBeLessThan(rootHi + 0.01 + 1e-9);
        // Inside 0..1 and always contains the observed share.
        expect(r.lo).toBeGreaterThanOrEqual(0);
        expect(r.hi).toBeLessThanOrEqual(1);
        expect(r.lo).toBeLessThanOrEqual(ph);
        expect(r.hi).toBeGreaterThanOrEqual(ph);
      }
    }
  });

  it('gets narrower as the evidence grows (same share, more cases)', () => {
    const small = wilsonRange(3, 4)!;
    const big = wilsonRange(300, 400)!;
    expect(big.hi - big.lo).toBeLessThan(small.hi - small.lo);
  });
});

describe('formatPct', () => {
  it('prints 0% only for a real zero', () => {
    expect(formatPct(0, 12)).toBe('0%');
    expect(formatPct(0, 1)).toBe('0%');
  });

  it('is "not measured" when there is nothing to divide, never 0%', () => {
    expect(formatPct(0, 0)).toBe('not measured');
    expect(formatPct(3, 0)).toBe('not measured');
    expect(formatPct(5, 4)).toBe('not measured');
    expect(formatPct(-1, 4)).toBe('not measured');
    expect(formatPct(NaN, 4)).toBe('not measured');
  });

  it('does not round a tiny share to 0% or a near-total to 100%', () => {
    expect(formatPct(1, 300)).toBe('<1%');
    expect(formatPct(299, 300)).toBe('>99%');
    expect(formatPct(300, 300)).toBe('100%');
  });

  it('rounds an ordinary share to a whole percent', () => {
    expect(formatPct(1, 3)).toBe('33%');
    expect(formatPct(2, 3)).toBe('67%');
    expect(formatPct(9, 12)).toBe('75%');
    expect(formatPct(1, 150)).toBe('1%');
  });
});

describe('nonOverlapping', () => {
  const eight = weekly('2026-10-26', Array.from({ length: 8 }, () => [3, 10] as [number, number]));

  it('with a 28-day period keeps every fourth weekly reading, starting from the newest', () => {
    const kept = nonOverlapping(eight, 28);
    expect(kept.map((r) => r.date)).toEqual(['2026-09-28', '2026-10-26']);
  });

  it('with a 7-day period keeps all weekly readings', () => {
    expect(nonOverlapping(eight, 7)).toHaveLength(8);
  });

  it('returns ascending whatever the input order', () => {
    const shuffled = [eight[3], eight[7], eight[0], eight[5], eight[1], eight[6], eight[2], eight[4]];
    expect(nonOverlapping(shuffled, 7).map((r) => r.date)).toEqual(eight.map((r) => r.date));
    expect(nonOverlapping([...eight].reverse(), 28).map((r) => r.date)).toEqual(['2026-09-28', '2026-10-26']);
  });

  it('drops a mid-week manual re-run that overlaps its neighbour', () => {
    const withRerun = [...weekly('2026-10-26', [[3, 10], [4, 10], [5, 10]]), rd('2026-10-21', 9, 10)];
    expect(nonOverlapping(withRerun, 7).map((r) => r.date)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
  });

  it('ignores readings that measured nothing', () => {
    const mixed = [rd('2026-10-12', 3, 10), nm('2026-10-19'), rd('2026-10-26', 4, 10)];
    expect(nonOverlapping(mixed, 7).map((r) => r.date)).toEqual(['2026-10-12', '2026-10-26']);
  });

  it('measures the gap from the last one KEPT, not from the neighbour', () => {
    // Ten daily readings, Oct 17 to Oct 26, with a 3-day period: 26, 23, 20, 17.
    const daily = Array.from({ length: 10 }, (_, i) => rd(addDays('2026-10-26', -i), 1, 10));
    expect(nonOverlapping(daily, 3).map((r) => r.date)).toEqual([
      '2026-10-17',
      '2026-10-20',
      '2026-10-23',
      '2026-10-26',
    ]);
  });

  it('is empty for nothing measured', () => {
    expect(nonOverlapping([], 7)).toEqual([]);
    expect(nonOverlapping([nm('2026-10-26')], 7)).toEqual([]);
  });
});

describe('pool', () => {
  it('sums counts and never averages rates', () => {
    const p = pool([rd('2026-10-12', 3, 4), rd('2026-10-19', 1, 10)])!;
    expect(p.hits).toBe(4);
    expect(p.n).toBe(14);
    expect(p.readings).toBe(2);
    expect(p.from).toBe('2026-10-12');
    expect(p.to).toBe('2026-10-19');
    // Not the mean of 75 percent and 10 percent (42.5), and not 4 of 14 re-derived by hand.
    expect(p.hits / p.n).toBeCloseTo(4 / 14, 10);
    expect(p.range).toEqual(wilsonRange(4, 14));
  });

  it('skips readings that measured nothing', () => {
    const p = pool([rd('2026-10-12', 3, 4), nm('2026-10-19'), rd('2026-10-26', 0, 6)])!;
    expect(p.hits).toBe(3);
    expect(p.n).toBe(10);
    expect(p.readings).toBe(2);
  });

  it('keeps a real zero as a pooled count', () => {
    const p = pool([rd('2026-10-26', 0, 12)])!;
    expect(p.hits).toBe(0);
    expect(p.n).toBe(12);
    expect(p.range.lo).toBe(0);
  });

  it('is null when nothing was measured', () => {
    expect(pool([])).toBeNull();
    expect(pool([nm('2026-10-26'), nm('2026-10-19')])).toBeNull();
  });
});

describe('compareRecent', () => {
  it('is too-few for nothing measured, with no anchor', () => {
    expect(compareRecent([], 7)).toEqual({ verdict: 'too-few', anchor: null, latest: null, earlier: null });
    expect(compareRecent([nm('2026-10-26')], 7).anchor).toBeNull();
  });

  it('is too-few when either side is under 10 cases, including exactly 9 against 10', () => {
    // Latest block: 4 weekly readings of 3 cases each, 12 in total. Earlier: 9 cases.
    const latest = weekly('2026-10-26', Array.from({ length: 4 }, () => [1, 3] as [number, number]));
    const earlierNine = [rd('2026-09-28', 4, 9)];
    const earlierTen = [rd('2026-09-28', 4, 10)];
    expect(compareRecent([...earlierNine, ...latest], 7).verdict).toBe('too-few');
    expect(compareRecent([...earlierTen, ...latest], 7).verdict).not.toBe('too-few');
    // Same at 28 days: one reading a side, 9 against 10.
    expect(compareRecent([rd('2026-09-28', 4, 10), rd('2026-10-26', 4, 9)], 28).verdict).toBe('too-few');
    expect(compareRecent([rd('2026-09-28', 4, 9), rd('2026-10-26', 4, 10)], 28).verdict).toBe('too-few');
    expect(compareRecent([rd('2026-09-28', 4, 10), rd('2026-10-26', 4, 10)], 28).verdict).toBe('no-clear-change');
  });

  it('keeps the pooled sides on a too-few result so a tile can still show the counts', () => {
    const c = compareRecent([rd('2026-09-28', 4, 9), rd('2026-10-26', 4, 10)], 28);
    expect(c.verdict).toBe('too-few');
    expect(c.latest?.n).toBe(10);
    expect(c.earlier?.n).toBe(9);
  });

  it('is too-few when there is no earlier block at all', () => {
    const c = compareRecent(weekly('2026-10-26', [[3, 10], [4, 10], [5, 10]]), 7);
    expect(c.verdict).toBe('too-few');
    expect(c.earlier).toBeNull();
    expect(c.latest?.n).toBe(30);
  });

  it('says no clear change when the ranges overlap, even if the point rates differ by 20 points', () => {
    // 4 weekly readings a side: 12 of 40 (30%) now against 20 of 40 (50%) before.
    const before = weekly('2026-09-28', Array.from({ length: 4 }, () => [5, 10] as [number, number]));
    const now = weekly('2026-10-26', Array.from({ length: 4 }, () => [3, 10] as [number, number]));
    const c = compareRecent([...before, ...now], 7);
    expect(c.latest).toMatchObject({ hits: 12, n: 40 });
    expect(c.earlier).toMatchObject({ hits: 20, n: 40 });
    expect(c.latest!.hits / c.latest!.n).toBeCloseTo(0.3, 10);
    expect(c.earlier!.hits / c.earlier!.n).toBeCloseTo(0.5, 10);
    expect(c.verdict).toBe('no-clear-change');
    // The ranges really do overlap, so this is not an accident of the data.
    expect(c.latest!.range.hi).toBeGreaterThanOrEqual(c.earlier!.range.lo);
  });

  it('calls lower when the latest range lies wholly below the earlier one', () => {
    const before = weekly('2026-09-28', Array.from({ length: 4 }, () => [18, 30] as [number, number])); // 72 of 120
    const now = weekly('2026-10-26', Array.from({ length: 4 }, () => [6, 30] as [number, number])); // 24 of 120
    const c = compareRecent([...before, ...now], 7);
    expect(c.latest!.range.hi).toBeLessThan(c.earlier!.range.lo);
    expect(c.verdict).toBe('lower');
  });

  it('calls higher when the latest range lies wholly above the earlier one', () => {
    const before = weekly('2026-09-28', Array.from({ length: 4 }, () => [6, 30] as [number, number]));
    const now = weekly('2026-10-26', Array.from({ length: 4 }, () => [18, 30] as [number, number]));
    const c = compareRecent([...before, ...now], 7);
    expect(c.latest!.range.lo).toBeGreaterThan(c.earlier!.range.hi);
    expect(c.verdict).toBe('higher');
  });

  it('treats touching ranges as overlapping', () => {
    // 5 of 10 now and 5 of 10 before have identical ranges; a range that exactly meets
    // another is also an overlap. Build the touching case from the real ranges.
    const base = compareRecent([rd('2026-09-28', 5, 10), rd('2026-10-26', 5, 10)], 28);
    expect(base.verdict).toBe('no-clear-change');
    // Search for a pair whose bounds are exactly equal and check it is not called a change,
    // in BOTH directions: the lower side touching from above (the latest is the lower), and
    // the higher side touching from below (the latest is the higher). They are separate
    // comparisons in compareRecent, so a regression in one would not show in the other.
    let found = 0;
    for (let hitsA = 0; hitsA <= 40; hitsA++) {
      for (let hitsB = hitsA; hitsB <= 40; hitsB++) {
        const a = wilsonRange(hitsA, 40)!;
        const b = wilsonRange(hitsB, 40)!;
        if (a.hi === b.lo) {
          found++;
          // The lower reading is the latest: latest.hi === earlier.lo.
          const lowerNow = compareRecent([rd('2026-09-28', hitsB, 40), rd('2026-10-26', hitsA, 40)], 28);
          expect(lowerNow.latest!.range.hi).toBe(lowerNow.earlier!.range.lo);
          expect(lowerNow.verdict).toBe('no-clear-change');
          // The higher reading is the latest: latest.lo === earlier.hi.
          const higherNow = compareRecent([rd('2026-09-28', hitsA, 40), rd('2026-10-26', hitsB, 40)], 28);
          expect(higherNow.latest!.range.lo).toBe(higherNow.earlier!.range.hi);
          expect(higherNow.verdict).toBe('no-clear-change');
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('one whole percent of daylight between the ranges is a change, in both directions', () => {
    // The boundary is strict: a gap, however small, is called. Find the nearest pair that has one.
    let found = 0;
    for (let hitsA = 0; hitsA <= 40; hitsA++) {
      for (let hitsB = hitsA + 1; hitsB <= 40; hitsB++) {
        const a = wilsonRange(hitsA, 40)!;
        const b = wilsonRange(hitsB, 40)!;
        if (a.hi < b.lo) {
          found++;
          expect(compareRecent([rd('2026-09-28', hitsB, 40), rd('2026-10-26', hitsA, 40)], 28).verdict).toBe('lower');
          expect(compareRecent([rd('2026-09-28', hitsA, 40), rd('2026-10-26', hitsB, 40)], 28).verdict).toBe('higher');
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('with 28-day readings compares the newest with the one exactly 28 days older, never its 7-day neighbour', () => {
    // Ten weekly readings. Only the newest and the one 28 days older may be pooled.
    const counts: Array<[number, number]> = [
      [9, 10], [9, 10], [9, 10], [9, 10], [9, 10], [9, 10], [2, 11], [2, 12], [2, 13], [6, 14],
    ];
    const ten = weekly('2026-10-26', counts, { periodDays: 28 });
    const c = compareRecent(ten, 28);
    expect(c.anchor).toBe('2026-10-26');
    expect(c.latest).toMatchObject({ hits: 6, n: 14, readings: 1, from: '2026-10-26', to: '2026-10-26' });
    // 28 days before Oct 26 is Sep 28, which is the sixth of the ten (index 5).
    expect(ten[5].date).toBe('2026-09-28');
    expect(c.earlier).toMatchObject({ hits: 9, n: 10, readings: 1, from: '2026-09-28', to: '2026-09-28' });
    // Not the sum of the ten.
    const total = counts.reduce((s, [, n]) => s + n, 0);
    expect(c.latest!.n + c.earlier!.n).toBeLessThan(total);
  });

  it('with 28-day readings and no reading 28 days older there is nothing to compare against', () => {
    // The neighbours are 7, 14 and 21 days older: all in the latest block, none in the earlier.
    const c = compareRecent(weekly('2026-10-26', [[5, 10], [5, 10], [5, 10], [5, 10]], { periodDays: 28 }), 28);
    expect(c.verdict).toBe('too-few');
    expect(c.earlier).toBeNull();
    expect(c.latest).toMatchObject({ n: 10, readings: 1 });
  });

  it('a null newest week does not shift the window', () => {
    const before = weekly('2026-09-28', Array.from({ length: 4 }, () => [18, 30] as [number, number]));
    const now = weekly('2026-10-26', Array.from({ length: 4 }, () => [6, 30] as [number, number]));
    const withNull = [...before, ...now, nm('2026-11-02')];
    const c = compareRecent(withNull, 7);
    expect(c.anchor).toBe('2026-10-26');
    expect(c).toEqual(compareRecent([...before, ...now], 7));
    expect(c.verdict).toBe('lower');
  });

  it('with 7-day readings pools up to four a side, and nothing older than the earlier block', () => {
    // Twelve contiguous weeks, none shared between series. The oldest four (9 of 10 each) are
    // 56 days or more before the anchor and must not be pooled into either side.
    const old = weekly('2026-09-07', Array.from({ length: 4 }, () => [9, 10] as [number, number]));
    const before = weekly('2026-10-05', Array.from({ length: 4 }, () => [1, 10] as [number, number]));
    const now = weekly('2026-11-02', Array.from({ length: 4 }, () => [2, 10] as [number, number]));
    const c = compareRecent([...old, ...before, ...now], 7);
    expect(c.anchor).toBe('2026-11-02');
    expect(c.latest).toMatchObject({ hits: 8, n: 40, readings: 4, from: '2026-10-12', to: '2026-11-02' });
    expect(c.earlier).toMatchObject({ hits: 4, n: 40, readings: 4, from: '2026-09-14', to: '2026-10-05' });
  });

  it('a date that appears twice (a re-run of the same week) is not counted twice on either side', () => {
    // nonOverlapping keeps one reading per period, so an overlap cannot inflate n.
    const now = weekly('2026-11-02', Array.from({ length: 4 }, () => [2, 10] as [number, number]));
    const before = weekly('2026-10-05', Array.from({ length: 4 }, () => [1, 10] as [number, number]));
    const dup = [...before, ...now, rd('2026-11-02', 9, 10)];
    const c = compareRecent(dup, 7);
    expect(c.latest!.readings).toBe(4);
    expect(c.latest!.n).toBe(40);
  });

  it('gives the same result for reversed or shuffled input', () => {
    const before = weekly('2026-09-28', Array.from({ length: 4 }, () => [18, 30] as [number, number]));
    const now = weekly('2026-10-26', Array.from({ length: 4 }, () => [6, 30] as [number, number]));
    const all = [...before, ...now];
    const expected = compareRecent(all, 7);
    expect(compareRecent([...all].reverse(), 7)).toEqual(expected);
    const shuffled = [all[5], all[0], all[7], all[2], all[4], all[1], all[6], all[3]];
    expect(compareRecent(shuffled, 7)).toEqual(expected);
  });

  it('a real zero is a measured side, not a missing one', () => {
    const c = compareRecent([rd('2026-09-28', 8, 12), rd('2026-10-26', 0, 12)], 28);
    expect(c.latest).toMatchObject({ hits: 0, n: 12 });
    expect(c.verdict).toBe('lower');
  });

  it('states a movement only; the result carries no direction-of-better', () => {
    const c = compareRecent([rd('2026-09-28', 8, 12), rd('2026-10-26', 0, 12)], 28);
    expect(Object.keys(c).sort()).toEqual(['anchor', 'earlier', 'latest', 'verdict']);
  });
});
