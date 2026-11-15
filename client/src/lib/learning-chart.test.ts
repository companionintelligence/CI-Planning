import { describe, it, expect } from 'vitest';
import { layoutTrend, type ChartPoint, type ChartLayout } from './learning-chart.js';
import { addDays, shortDate } from './dates.js';

const pt = (date: string, value: number | null, n: number): ChartPoint => ({ date, value, n, label: `${date} n=${n}` });
/** Weekly points ending at `end`: [value, n] oldest first. */
const weekly = (end: string, spec: Array<[number | null, number]>): ChartPoint[] =>
  spec.map(([v, n], i) => pt(addDays(end, -7 * (spec.length - 1 - i)), v, n));

const opts = { cadenceDays: 7 };

/** Every number anywhere in a layout, to prove none is NaN or Infinity. */
function numbers(l: ChartLayout): number[] {
  const out: number[] = [l.width, l.height, ...Object.values(l.plot)];
  for (const d of l.dots) out.push(d.x, d.y);
  for (const t of l.ticks) out.push(t.x);
  for (const x of l.xLabels) out.push(x.x);
  for (const y of l.yLabels) out.push(y.y);
  if (l.marker) out.push(l.marker.x);
  for (const s of l.segments) out.push(...(s.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number));
  return out;
}

describe('layoutTrend: the fixed scale', () => {
  it('always labels exactly 0% and 100%, with 0 at the bottom and 100 at the top', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.7, 20], [0.8, 20]]), opts);
    expect(l.yLabels.map((y) => y.text).sort()).toEqual(['0%', '100%']);
    const y0 = l.yLabels.find((y) => y.text === '0%')!.y;
    const y100 = l.yLabels.find((y) => y.text === '100%')!.y;
    expect(y100).toBeLessThan(y0);
    expect(y100).toBe(l.plot.top);
    expect(y0).toBe(l.plot.bottom);
  });

  it('puts a value of 1 at the top and 0 at the bottom, whatever the data min and max are', () => {
    const l = layoutTrend([pt('2026-10-19', 1, 20), pt('2026-10-26', 0, 12)], opts);
    expect(l.dots[0].y).toBe(l.plot.top);
    expect(l.dots[1].y).toBe(l.plot.bottom);
  });

  it('does not fit the scale: two near-identical values stay near each other', () => {
    const near = layoutTrend([pt('2026-10-19', 0.7, 20), pt('2026-10-26', 0.72, 20)], opts);
    const gap = Math.abs(near.dots[0].y - near.dots[1].y);
    const plotH = near.plot.bottom - near.plot.top;
    expect(gap).toBeCloseTo(0.02 * plotH, 1);
    // And 0.5 is the middle of the plot, not the middle of the data's range.
    const mid = layoutTrend([pt('2026-10-19', 0.5, 20), pt('2026-10-26', 0.5, 20)], opts);
    expect(mid.dots[0].y).toBeCloseTo((mid.plot.top + mid.plot.bottom) / 2, 1);
  });

  it('keeps the labels the same for an empty chart', () => {
    const l = layoutTrend([], opts);
    expect(l.yLabels.map((y) => y.text).sort()).toEqual(['0%', '100%']);
    expect(l.dots).toEqual([]);
    expect(l.segments).toEqual([]);
    expect(l.ticks).toEqual([]);
    expect(l.xLabels).toEqual([]);
    expect(l.marker).toBeNull();
  });

  it('defaults to a 260 by 84 box and honours width and height', () => {
    expect(layoutTrend([], opts)).toMatchObject({ width: 260, height: 84 });
    expect(layoutTrend([], { ...opts, width: 400, height: 90 })).toMatchObject({ width: 400, height: 90 });
  });
});

describe('layoutTrend: dots, ticks and gaps', () => {
  it('a null reading is a tick, not a dot', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.5, 20], [null, 0], [0.6, 20]]), opts);
    expect(l.dots).toHaveLength(2);
    expect(l.ticks).toHaveLength(1);
    expect(l.ticks[0].label).toBe('2026-10-19 n=0');
  });

  it('a null reading splits the line in two', () => {
    const l = layoutTrend(weekly('2026-11-09', [[0.5, 20], [0.55, 20], [null, 0], [0.6, 20], [0.65, 20]]), opts);
    expect(l.segments).toHaveLength(2);
    expect(l.dots).toHaveLength(4);
  });

  it('a real zero is a dot at the bottom; a null in the same place is not a dot', () => {
    const zero = layoutTrend([pt('2026-10-26', 0, 12)], opts);
    expect(zero.dots).toHaveLength(1);
    expect(zero.dots[0].y).toBe(zero.plot.bottom);
    expect(zero.ticks).toHaveLength(0);
    const nul = layoutTrend([pt('2026-10-26', null, 0)], opts);
    expect(nul.dots).toHaveLength(0);
    expect(nul.ticks).toHaveLength(1);
  });

  it('a date gap above 1.5 cadences (a missing week) splits the line even with no null', () => {
    // Oct 12, then Oct 26 (14 days, a missing week), then Nov 2.
    const l = layoutTrend([pt('2026-10-05', 0.5, 20), pt('2026-10-12', 0.5, 20), pt('2026-10-26', 0.5, 20), pt('2026-11-02', 0.5, 20)], opts);
    expect(l.segments).toHaveLength(2);
    expect(l.ticks).toHaveLength(0);
    expect(l.dots).toHaveLength(4);
  });

  it('a gap of exactly 10.5 days still joins, above it does not', () => {
    const joined = layoutTrend([pt('2026-10-01', 0.5, 20), pt('2026-10-11', 0.5, 20)], opts); // 10 days
    expect(joined.segments).toHaveLength(1);
    const broken = layoutTrend([pt('2026-10-01', 0.5, 20), pt('2026-10-12', 0.5, 20)], opts); // 11 days
    expect(broken.segments).toHaveLength(0);
    const cadence28 = layoutTrend([pt('2026-10-01', 0.5, 20), pt('2026-10-12', 0.5, 20)], { cadenceDays: 28 });
    expect(cadence28.segments).toHaveLength(1);
  });

  it('four consecutive weekly points give one segment', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.5, 20], [0.55, 20], [0.6, 20], [0.65, 20]]), opts);
    expect(l.segments).toHaveLength(1);
    expect(l.segments[0].dashed).toBe(false);
    // One M and three L: four points on one path.
    expect(l.segments[0].d.match(/M/g)).toHaveLength(1);
    expect(l.segments[0].d.match(/L/g)).toHaveLength(3);
  });

  it('a lone point has no segment, and neither does a point cut off on both sides', () => {
    expect(layoutTrend([pt('2026-10-26', 0.5, 20)], opts).segments).toEqual([]);
    const isolated = layoutTrend(weekly('2026-11-02', [[0.5, 20], [null, 0], [0.5, 20], [null, 0], [0.5, 20]]), opts);
    expect(isolated.segments).toEqual([]);
    expect(isolated.dots).toHaveLength(3);
  });

  it('draws nothing at all between two dots with only a tick between them', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.5, 20], [null, 0], [0.5, 20]]), opts);
    expect(l.segments).toEqual([]);
  });

  it('a value outside 0..1 or NaN is a tick, never a dot or a clamped dot', () => {
    const l = layoutTrend([pt('2026-10-12', 1.4, 20), pt('2026-10-19', -0.2, 20), pt('2026-10-26', NaN, 20)], opts);
    expect(l.dots).toEqual([]);
    expect(l.ticks).toHaveLength(3);
  });
});

describe('layoutTrend: hollow dots and dashed segments', () => {
  it('a dot is hollow exactly when n is under minN (9 hollow, 10 not)', () => {
    const l = layoutTrend([pt('2026-10-19', 0.5, 9), pt('2026-10-26', 0.5, 10)], opts);
    expect(l.dots.map((d) => d.hollow)).toEqual([true, false]);
  });

  it('honours a custom minN', () => {
    const l = layoutTrend([pt('2026-10-19', 0.5, 4), pt('2026-10-26', 0.5, 5)], { ...opts, minN: 5 });
    expect(l.dots.map((d) => d.hollow)).toEqual([true, false]);
  });

  it('a segment touching a hollow dot is dashed', () => {
    const l = layoutTrend([pt('2026-10-19', 0.5, 9), pt('2026-10-26', 0.5, 20)], opts);
    expect(l.segments).toEqual([expect.objectContaining({ dashed: true })]);
    const solid = layoutTrend([pt('2026-10-19', 0.5, 10), pt('2026-10-26', 0.5, 20)], opts);
    expect(solid.segments).toEqual([expect.objectContaining({ dashed: false })]);
  });

  it('splits a run by style: solid between filled dots, dashed on either side of a hollow one', () => {
    // filled, filled, hollow, filled, filled
    const l = layoutTrend(weekly('2026-11-02', [[0.5, 20], [0.5, 20], [0.5, 5], [0.5, 20], [0.5, 20]]), opts);
    expect(l.segments.map((s) => s.dashed)).toEqual([false, true, false]);
    // The dashed one carries both neighbours of the hollow dot: three points.
    expect(l.segments[1].d.match(/L/g)).toHaveLength(2);
  });

  it('all-hollow weekly points are one dashed segment', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.5, 3], [0.5, 4], [0.5, 5], [0.5, 6]]), opts);
    expect(l.segments).toHaveLength(1);
    expect(l.segments[0].dashed).toBe(true);
  });

  it('a dot carries its label for the hover text', () => {
    const l = layoutTrend([{ date: '2026-10-26', value: 0.5, n: 20, label: 'Oct 26: 10 of 20' }], opts);
    expect(l.dots[0].label).toBe('Oct 26: 10 of 20');
  });
});

describe('layoutTrend: x is by calendar date', () => {
  it('a 14-day gap is twice as wide as a 7-day gap', () => {
    const l = layoutTrend([pt('2026-10-05', 0.5, 20), pt('2026-10-12', 0.5, 20), pt('2026-10-26', 0.5, 20)], opts);
    const [a, b, c] = l.dots.map((d) => d.x);
    expect(c - b).toBeCloseTo(2 * (b - a), 1);
  });

  it('spans the plot from first to last reading', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.5, 20], [0.5, 20], [0.5, 20]]), opts);
    expect(l.dots[0].x).toBe(l.plot.left);
    expect(l.dots[2].x).toBe(l.plot.right);
  });

  it('a single point is centred', () => {
    const l = layoutTrend([pt('2026-10-26', 0.5, 20)], opts);
    expect(l.dots[0].x).toBeCloseTo((l.plot.left + l.plot.right) / 2, 1);
  });

  it('two readings on the same date are centred, not divided by zero', () => {
    const l = layoutTrend([pt('2026-10-26', 0.5, 20), pt('2026-10-26', 0.6, 20)], opts);
    expect(numbers(l).every(Number.isFinite)).toBe(true);
    expect(l.dots[0].x).toBe(l.dots[1].x);
  });

  it('does not trust the order of the input', () => {
    const asc = weekly('2026-10-26', [[0.4, 20], [0.5, 20], [0.6, 20]]);
    const a = layoutTrend(asc, opts);
    const b = layoutTrend([asc[2], asc[0], asc[1]], opts);
    expect(b).toEqual(a);
  });

  it('labels the first and last reading date with shortDate', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.5, 20], [0.5, 20], [0.5, 20]]), opts);
    expect(l.xLabels.map((x) => x.text)).toEqual([shortDate('2026-10-12'), shortDate('2026-10-26')]);
    expect(l.xLabels[0].x).toBe(l.plot.left);
    expect(l.xLabels[1].x).toBe(l.plot.right);
  });

  it('labels one date once when there is only one', () => {
    const l = layoutTrend([pt('2026-10-26', 0.5, 20), pt('2026-10-26', null, 0)], opts);
    expect(l.xLabels).toHaveLength(1);
  });

  it('the first and last labels use the null readings too, since the axis covers them', () => {
    const l = layoutTrend(weekly('2026-11-02', [[null, 0], [0.5, 20], [null, 0]]), opts);
    expect(l.xLabels.map((x) => x.text)).toEqual([shortDate('2026-10-19'), shortDate('2026-11-02')]);
  });
});

describe('layoutTrend: the marker', () => {
  const pts = weekly('2026-10-26', [[0.5, 20], [0.5, 20], [0.5, 20], [0.5, 20]]);

  it('sits where a point with that date would sit, on the same date scale', () => {
    for (const date of ['2026-10-05', '2026-10-12', '2026-10-15', '2026-10-26']) {
      const l = layoutTrend(pts, { ...opts, marker: { date, text: 'Examples stored' } });
      // The same chart with a real reading added on that date: its dot is where the marker is.
      const probe = layoutTrend([...pts, { date, value: 0.5, n: 20, label: 'probe' }], opts);
      expect(l.marker!.x).toBe(probe.dots.find((d) => d.label === 'probe')!.x);
      expect(l.marker!.text).toBe('Examples stored');
    }
  });

  it('lands exactly on an existing reading when the dates match', () => {
    const l = layoutTrend(pts, { ...opts, marker: { date: '2026-10-12', text: 'm' } });
    expect(l.marker!.x).toBe(l.dots[1].x);
  });

  it('falls between two readings when its date does', () => {
    const l = layoutTrend(pts, { ...opts, marker: { date: '2026-10-15', text: 'm' } });
    expect(l.marker!.x).toBeGreaterThan(l.dots[1].x);
    expect(l.marker!.x).toBeLessThan(l.dots[2].x);
  });

  it('is null outside the plotted range, before or after', () => {
    expect(layoutTrend(pts, { ...opts, marker: { date: '2026-09-01', text: 'm' } }).marker).toBeNull();
    expect(layoutTrend(pts, { ...opts, marker: { date: '2026-11-30', text: 'm' } }).marker).toBeNull();
  });

  it('sits on an edge when it is the first or last reading date', () => {
    const l = layoutTrend(pts, { ...opts, marker: { date: '2026-10-05', text: 'm' } });
    expect(l.marker!.x).toBe(l.plot.left);
  });

  it('is null when not asked for, when the date is unreadable, or when there are no points', () => {
    expect(layoutTrend(pts, opts).marker).toBeNull();
    expect(layoutTrend(pts, { ...opts, marker: null }).marker).toBeNull();
    expect(layoutTrend(pts, { ...opts, marker: { date: 'nope', text: 'm' } }).marker).toBeNull();
    expect(layoutTrend([], { ...opts, marker: { date: '2026-10-12', text: 'm' } }).marker).toBeNull();
  });
});

describe('layoutTrend: no NaN', () => {
  it('skips points with an unparseable date and produces only finite numbers', () => {
    const l = layoutTrend(
      [pt('', 0.5, 20), pt('garbage', 0.5, 20), pt('2026-02-31', 0.5, 20), pt('2026-10-19', 0.5, 20), pt('2026-10-26', 0.6, 20)],
      { ...opts, marker: { date: 'also bad', text: 'm' } },
    );
    expect(l.dots).toHaveLength(2);
    expect(numbers(l).every(Number.isFinite)).toBe(true);
    for (const seg of l.segments) expect(seg.d).not.toMatch(/NaN|Infinity/);
  });

  it('survives garbage options', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.5, 20], [0.5, 20]]), {
      cadenceDays: NaN,
      width: -5,
      height: NaN,
      minN: NaN,
    });
    expect(numbers(l).every(Number.isFinite)).toBe(true);
    expect(l.width).toBe(260);
    expect(l.height).toBe(84);
    expect(l.segments).toHaveLength(1);
  });

  it('survives a very narrow box', () => {
    const l = layoutTrend(weekly('2026-10-26', [[0.5, 20], [0.5, 20]]), { ...opts, width: 10, height: 10 });
    expect(numbers(l).every(Number.isFinite)).toBe(true);
    expect(l.plot.right).toBeGreaterThan(l.plot.left);
    expect(l.plot.bottom).toBeGreaterThan(l.plot.top);
  });

  it('puts every dot and tick inside the plot area', () => {
    const l = layoutTrend(weekly('2026-11-02', [[0, 12], [1, 12], [null, 0], [0.37, 3], [0.9, 40]]), opts);
    for (const d of l.dots) {
      expect(d.x).toBeGreaterThanOrEqual(l.plot.left);
      expect(d.x).toBeLessThanOrEqual(l.plot.right);
      expect(d.y).toBeGreaterThanOrEqual(l.plot.top);
      expect(d.y).toBeLessThanOrEqual(l.plot.bottom);
    }
    for (const t of l.ticks) {
      expect(t.x).toBeGreaterThanOrEqual(l.plot.left);
      expect(t.x).toBeLessThanOrEqual(l.plot.right);
    }
  });
});
