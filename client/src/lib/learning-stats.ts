/**
 * Settings → Learning: the honesty rules as code.
 *
 * Pure: no Solid, no DOM, no fetch. Everything downstream of the normalisers
 * (lib/learning-series.ts) sees only `Reading`, so ordering, nulls and units are decided
 * in one place and a tile cannot get them wrong on its own.
 *
 * What this module will never do, on purpose:
 *   - turn a null or an empty reading into a number (a week that measured nothing is
 *     `measured: false`, and `readingValue` returns null for it);
 *   - average rates, interpolate a missing week, or fit a scale to the data;
 *   - say which direction is "better". That is a label a tile prints, not an input here.
 *
 * Rates are derived from the COUNTS (`hits` over `n`). The rate the server sends is used
 * only to detect "nothing was measured" (null), never copied through.
 */

/** Below this many cases: counts only, a hollow dot, no percent, no comparison. A
 *  presentation threshold, not a statistical claim. */
export const MIN_N = 10;
/** Comparison block length in days: the latest 28 days against the 28 before. */
export const BLOCK_DAYS = 28;
/** The weekly pass. A date gap above 1.5 x this breaks a chart line. */
export const CADENCE_DAYS = 7;
/** Weekly plus two days. Used only by the dismissal and placement cards, which write a
 *  row every Monday; the other two legitimately write nothing in a quiet week. */
export const STALE_AFTER_DAYS = 9;
/** Two-sided 95 percent. */
export const WILSON_Z = 1.96;
/** Request limits. These count ROWS, not weeks: classification across two fields, plan
 *  loop across stages. Twelve weeks is enough for the chart and for 28-day pooling. */
export const LEARNING_LIMITS = { classification: 24, dismissal: 12, placement: 12, planLoop: 24 } as const;

const NOT_MEASURED = 'not measured';
/** Tolerance so an exact whole-percent bound is not widened by floating-point noise. */
const EPS = 1e-9;
const DAY_MS = 86_400_000;

/** One weekly reading of one series, in the same units whichever loop it came from. */
export interface Reading {
  /** Owner-local YYYY-MM-DD, the wire computed_date. */
  date: string;
  /** dismissal 7, placement 28, plan loop 7 (the wire period_days); classification 90 (its
   *  evidence window; classification is never pooled). */
  periodDays: number;
  /** Cases: held_out | decided | decided | runs. */
  n: number;
  /** Successes: correct | dismissed | accepted | passed. */
  hits: number;
  /**
   * True ONLY when the wire rate is a finite number in 0..1 AND n > 0 AND 0 <= hits <= n.
   * Anything else is "not measured". A real zero (rate 0 with n 12) is measured.
   */
  measured: boolean;
  /** hinted | biased; undefined for the other two loops. */
  influence?: 0 | 1;
  /** The remaining wire columns a tile needs (see lib/learning-series.ts). */
  extra: Record<string, number | null>;
}

/** Fractions 0..1 that are whole-percent multiples: lo floored, hi ceiled. */
export interface Range {
  lo: number;
  hi: number;
}

export interface Pooled {
  hits: number;
  n: number;
  /** How many readings were summed. */
  readings: number;
  /** Earliest and latest reading date that went in. */
  from: string;
  to: string;
  range: Range;
}

export type Verdict = 'too-few' | 'no-clear-change' | 'lower' | 'higher';

export interface Comparison {
  verdict: Verdict;
  /** Date of the newest measured reading, or null when nothing was measured. */
  anchor: string | null;
  latest: Pooled | null;
  earlier: Pooled | null;
}

// ── Dates ────────────────────────────────────────────────────────────────────
// Parsed by parts, never `new Date('YYYY-MM-DD')`: that is UTC midnight and reads as the
// previous day west of Greenwich. They live here (the leaf module) so the stats and the
// series normalisers share ONE implementation; lib/learning-series.ts re-exports them.

/**
 * Whole days since 1970-01-01 for a YYYY-MM-DD string, from `Date.UTC` of the parsed
 * parts. null if it is not a real calendar date.
 */
export function dayNumber(ymd: string): number | null {
  if (typeof ymd !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.slice(0, 10));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  // Round-trip, so 2026-02-31 and 2026-13-01 are rejected rather than rolled over.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

/** `dayNumber(b) - dayNumber(a)`; NaN when either is unparseable. */
export function daysBetween(a: string, b: string): number {
  const x = dayNumber(a);
  const y = dayNumber(b);
  return x === null || y === null ? NaN : y - x;
}

// ── Single readings ──────────────────────────────────────────────────────────

/** A reading that may be used in arithmetic. `measured` is set by the normalisers; this
 *  re-checks the invariants so a hand-built reading cannot reach a division by zero. */
function usable(r: Reading): boolean {
  return (
    r.measured &&
    Number.isFinite(r.n) &&
    Number.isFinite(r.hits) &&
    r.n > 0 &&
    r.hits >= 0 &&
    r.hits <= r.n
  );
}

/** The ONLY place a rate is derived: hits over n, or null when nothing was measured. */
export function readingValue(r: Reading): number | null {
  return usable(r) ? r.hits / r.n : null;
}

/**
 * Wilson score interval at 95 percent, rounded OUTWARD to whole percents (lo floored, hi
 * ceiled) so the stated range is never narrower than the maths allows. Exact whole-percent
 * bounds are not widened (1e-9 tolerance). hits 0 forces lo 0 and hits n forces hi 1.
 *
 * null when n <= 0 or hits is outside 0..n, so a corrupt row has no range at all.
 *
 *   center = (p + z^2/2n) / (1 + z^2/n)
 *   half   = z * sqrt(p(1-p)/n + z^2/4n^2) / (1 + z^2/n)
 */
export function wilsonRange(hits: number, n: number): Range | null {
  if (!Number.isFinite(hits) || !Number.isFinite(n) || n <= 0 || hits < 0 || hits > n) return null;
  const p = hits / n;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lo = hits === 0 ? 0 : Math.floor((center - half) * 100 + EPS) / 100;
  const hi = hits === n ? 1 : Math.ceil((center + half) * 100 - EPS) / 100;
  return { lo: Math.max(0, lo), hi: Math.min(1, hi) };
}

/**
 * A percent that does not lie. 'not measured' when there is nothing to divide (or the
 * counts are impossible); '0%' only for hits 0 out of n > 0; '<1%' and '>99%' for values
 * that would round to 0 or 100 but are not; otherwise the rounded percent.
 *
 * This does NOT apply the MIN_N rule: callers go through describeRate in
 * lib/learning-copy.ts, which does.
 */
export function formatPct(hits: number, n: number): string {
  if (!Number.isFinite(hits) || !Number.isFinite(n) || n <= 0 || hits < 0 || hits > n) return NOT_MEASURED;
  if (hits === 0) return '0%';
  if (hits === n) return '100%';
  const rounded = Math.round((100 * hits) / n);
  if (rounded <= 0) return '<1%';
  if (rounded >= 100) return '>99%';
  return `${rounded}%`;
}

/** '46% to 92%'. */
export function formatRange(r: Range): string {
  return `${Math.round(r.lo * 100)}% to ${Math.round(r.hi * 100)}%`;
}

// ── Selecting and pooling ────────────────────────────────────────────────────

interface Dated {
  r: Reading;
  day: number;
}

/** Usable readings with a parseable date, ascending by date (stable on ties). */
function datedUsable(readings: readonly Reading[]): Dated[] {
  const out: Dated[] = [];
  for (const r of readings) {
    if (!usable(r)) continue;
    const day = dayNumber(r.date);
    if (day === null) continue;
    out.push({ r, day });
  }
  return out.sort((a, b) => a.day - b.day);
}

/**
 * The readings whose periods do not overlap, so their counts can be added without
 * counting a case twice. Considers measured readings only. Greedy, newest first: keep
 * the newest, then the next older reading that is at least `periodDays` before the last
 * one kept. Returns ascending; input order is irrelevant.
 *
 * Weekly readings with a 28-day period keep every fourth one. Weekly readings with a
 * 7-day period keep them all. A mid-week manual re-run is dropped.
 */
export function nonOverlapping(readings: Reading[], periodDays: number): Reading[] {
  const newestFirst = datedUsable(readings).reverse();
  const kept: Dated[] = [];
  for (const item of newestFirst) {
    const last = kept[kept.length - 1];
    if (!last || last.day - item.day >= periodDays) kept.push(item);
  }
  return kept.reverse().map((x) => x.r);
}

/**
 * Sums hits and n over the measured readings. NEVER averages rates: 3 of 4 plus 1 of 10 is
 * 4 of 14, not the mean of 75 percent and 10 percent. Null when none were measured.
 *
 * The caller is responsible for passing non-overlapping readings (see nonOverlapping).
 */
export function pool(readings: Reading[]): Pooled | null {
  const items = datedUsable(readings);
  if (items.length === 0) return null;
  let hits = 0;
  let n = 0;
  for (const { r } of items) {
    hits += r.hits;
    n += r.n;
  }
  // Every item passed `usable`, so n > 0 and 0 <= hits <= n and the range exists.
  const range = wilsonRange(hits, n) as Range;
  return {
    hits,
    n,
    readings: items.length,
    from: items[0].r.date,
    to: items[items.length - 1].r.date,
    range,
  };
}

/**
 * The latest 28 days against the 28 days before them. Counts are pooled (never rates
 * averaged) over non-overlapping readings, each side needs MIN_N cases, and a difference
 * is called only when the two Wilson ranges fully separate. Everything else is "no clear
 * change", which is the common honest answer at these sample sizes.
 *
 *   1. Only measured readings count. None: too-few.
 *   2. The anchor is the date of the newest MEASURED reading, so a null newest week does
 *      not shift the window.
 *   3. latest block = readings 0 to 27 days before the anchor; earlier block = 28 to 55.
 *   4. Each block goes through nonOverlapping(block, periodDays) and then pool().
 *      Dismissal passes 7 (up to four weekly readings a side). Placement passes 28, which
 *      leaves exactly one reading a side: the newest, and the newest one at least 28 days
 *      older.
 *   5. 'too-few' unless both sides exist and both have MIN_N cases. Then 'lower' when the
 *      latest range lies wholly below the earlier one, 'higher' when wholly above, else
 *      'no-clear-change' (touching ranges overlap).
 *
 * The verdict says how the rate moved. It does not say why, and it does not say whether
 * that is good: direction-of-better is a label the tile prints.
 */
export function compareRecent(readings: Reading[], periodDays: number): Comparison {
  const items = datedUsable(readings);
  if (items.length === 0) return { verdict: 'too-few', anchor: null, latest: null, earlier: null };

  const newest = items[items.length - 1];
  const anchor = newest.r.date;
  const block = (fromAgo: number, toAgo: number): Pooled | null => {
    const inBlock = items
      .filter((x) => {
        const ago = newest.day - x.day;
        return ago >= fromAgo && ago < toAgo;
      })
      .map((x) => x.r);
    return pool(nonOverlapping(inBlock, periodDays));
  };
  const latest = block(0, BLOCK_DAYS);
  const earlier = block(BLOCK_DAYS, 2 * BLOCK_DAYS);

  if (!latest || !earlier || latest.n < MIN_N || earlier.n < MIN_N) {
    return { verdict: 'too-few', anchor, latest, earlier };
  }
  let verdict: Verdict = 'no-clear-change';
  if (latest.range.hi < earlier.range.lo) verdict = 'lower';
  else if (latest.range.lo > earlier.range.hi) verdict = 'higher';
  return { verdict, anchor, latest, earlier };
}
