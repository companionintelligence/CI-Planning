/**
 * Settings → Learning: trend chart layout.
 *
 * Pure geometry, so the gap rules are unit-testable without a DOM. Returns coordinates and
 * path strings only; components/learning/TrendChart.tsx draws them.
 *
 * The rules this file enforces:
 *   - The scale is NOT an option. It is always 0 to 1 (0% to 100%), never fitted to the
 *     data, so a flat run of 3 of 4 cannot be stretched into a dramatic slope.
 *   - x is proportional to calendar date, not to index, so a missing week is a visible
 *     gap and a 14-day gap is twice as wide as a 7-day one.
 *   - A reading that exists but measured nothing (value null) is a tick, never a dot at 0.
 *   - The line breaks at a null reading and at a date gap larger than 1.5 cadences (a week
 *     with no row at all), and is dashed wherever it touches a hollow (thin-evidence) dot.
 *   - No NaN ever leaves this module. Points with an unparseable date are skipped.
 */

import { shortDate } from './dates.js';
import { dayNumber } from './learning-stats.js';

export interface ChartPoint {
  date: string;
  /** hits / n, or null when not measured. */
  value: number | null;
  n: number;
  /** Hover text, from pointLabel(). */
  label: string;
}

export interface TrendLayoutOptions {
  cadenceDays: number;
  /** Cases below which a dot is hollow. Default MIN_N (10). */
  minN?: number;
  /** Default 260. */
  width?: number;
  /** Default 84. */
  height?: number;
  marker?: { date: string; text: string } | null;
}

export interface ChartLayout {
  width: number;
  height: number;
  /** The drawable area inside the labels: y of `top` is 100 percent, y of `bottom` is 0. */
  plot: { left: number; right: number; top: number; bottom: number };
  /** Measured points only. Hollow iff n < minN. */
  dots: { x: number; y: number; hollow: boolean; label: string }[];
  /** Consecutive MEASURED points only, merged while the style repeats. Broken by a null
   *  reading and by a date gap above 1.5 x cadenceDays. Dashed when either end is hollow. A
   *  lone point has no segment. */
  segments: { d: string; dashed: boolean }[];
  /** Readings that exist but have value null. */
  ticks: { x: number; label: string }[];
  /** First and last reading date, via shortDate. */
  xLabels: { x: number; text: string }[];
  /** Always exactly '0%' and '100%'. */
  yLabels: { y: number; text: string }[];
  /** On the same date scale as the points; null when outside the plotted range. */
  marker: { x: number; text: string } | null;
}

const DEFAULT_MIN_N = 10;
// The box is drawn at (about) its own size: TrendChart caps the rendered width at DEFAULT_WIDTH
// pixels, so one user unit is about one pixel and 11-unit labels read at about 11 px. A wide
// box scaled down to a phone made them 6 or 7 px. Do not widen this without re-checking that.
const DEFAULT_WIDTH = 260;
const DEFAULT_HEIGHT = 84;
/** Room for the '100%' label on the left, the dot radius on the right, and 11 px labels above and below. */
const PAD = { left: 34, right: 10, top: 8, bottom: 22 } as const;
/** A gap larger than this many cadences breaks the line. */
const GAP_CADENCES = 1.5;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Two decimals is plenty for an SVG this size and keeps the path strings short. */
const r2 = (v: number) => Math.round(v * 100) / 100;
const pt = (x: number, y: number) => `${r2(x)} ${r2(y)}`;

interface Placed {
  p: ChartPoint;
  day: number;
  /** null when this reading has nothing to plot. */
  value: number | null;
  x: number;
  y: number;
  hollow: boolean;
}

export function layoutTrend(points: ChartPoint[], opts: TrendLayoutOptions): ChartLayout {
  const width = finite(opts.width) && opts.width > 0 ? opts.width : DEFAULT_WIDTH;
  const height = finite(opts.height) && opts.height > 0 ? opts.height : DEFAULT_HEIGHT;
  const minN = finite(opts.minN) ? opts.minN : DEFAULT_MIN_N;
  const cadence = finite(opts.cadenceDays) && opts.cadenceDays > 0 ? opts.cadenceDays : 7;

  const plot = { left: PAD.left, right: Math.max(PAD.left + 1, width - PAD.right), top: PAD.top, bottom: Math.max(PAD.top + 1, height - PAD.bottom) };
  const plotW = plot.right - plot.left;
  const plotH = plot.bottom - plot.top;

  // Date-ordered, parseable points only. Order from the caller is never trusted.
  const dated: { p: ChartPoint; day: number }[] = [];
  for (const p of points) {
    const day = dayNumber(p.date);
    if (day !== null) dated.push({ p, day });
  }
  dated.sort((a, b) => a.day - b.day);

  const minDay = dated.length ? dated[0].day : 0;
  const maxDay = dated.length ? dated[dated.length - 1].day : 0;
  const span = maxDay - minDay;
  // One distinct date (or none) is centred; otherwise x is proportional to the date.
  const xOf = (day: number) => (span > 0 ? plot.left + ((day - minDay) / span) * plotW : plot.left + plotW / 2);
  const yOf = (value: number) => plot.bottom - value * plotH;

  const placed: Placed[] = dated.map(({ p, day }) => {
    // A value outside 0..1 is corrupt: it is not plotted (it becomes a tick), never clamped
    // into a believable dot.
    const value = finite(p.value) && p.value >= 0 && p.value <= 1 ? p.value : null;
    return {
      p,
      day,
      value,
      x: xOf(day),
      y: value === null ? plot.bottom : yOf(value),
      hollow: !(p.n >= minN),
    };
  });

  const dots = placed
    .filter((q) => q.value !== null)
    .map((q) => ({ x: r2(q.x), y: r2(q.y), hollow: q.hollow, label: q.p.label }));

  const ticks = placed.filter((q) => q.value === null).map((q) => ({ x: r2(q.x), label: q.p.label }));

  // Segments: walk neighbouring readings; a pair is joined only when both are measured and
  // the date gap is within 1.5 cadences. Consecutive joined pairs with the same style are
  // merged into one path, so four filled weekly points are one solid segment.
  const runs: { parts: string[]; dashed: boolean }[] = [];
  let extendable = false; // true while the last run continues into the next joined pair
  for (let i = 1; i < placed.length; i++) {
    const a = placed[i - 1];
    const b = placed[i];
    const joined = a.value !== null && b.value !== null && b.day - a.day <= GAP_CADENCES * cadence;
    if (!joined) {
      extendable = false;
      continue;
    }
    const dashed = a.hollow || b.hollow;
    const last = runs[runs.length - 1];
    if (extendable && last && last.dashed === dashed) {
      last.parts.push(`L${pt(b.x, b.y)}`);
    } else {
      runs.push({ parts: [`M${pt(a.x, a.y)}`, `L${pt(b.x, b.y)}`], dashed });
      extendable = true;
    }
  }
  const segments = runs.map((s) => ({ d: s.parts.join(''), dashed: s.dashed }));

  const xLabels: { x: number; text: string }[] = [];
  if (placed.length) {
    const first = placed[0];
    const last = placed[placed.length - 1];
    xLabels.push({ x: r2(first.x), text: shortDate(first.p.date) });
    if (last.day !== first.day) xLabels.push({ x: r2(last.x), text: shortDate(last.p.date) });
  }

  let marker: ChartLayout['marker'] = null;
  if (opts.marker && placed.length) {
    const day = dayNumber(opts.marker.date);
    if (day !== null && day >= minDay && day <= maxDay) {
      marker = { x: r2(xOf(day)), text: opts.marker.text };
    }
  }

  return {
    width,
    height,
    plot: { left: plot.left, right: plot.right, top: plot.top, bottom: plot.bottom },
    dots,
    segments,
    ticks,
    xLabels,
    yLabels: [
      { y: r2(plot.bottom), text: '0%' },
      { y: r2(plot.top), text: '100%' },
    ],
    marker,
  };
}
