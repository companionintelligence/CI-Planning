/**
 * Calendar day-axis: a *piecewise* minute→pixel mapping that lets the calendar
 * collapse the quiet night hours into thin, expandable bars.
 *
 * The rest of the app (Planner, grid.ts) maps a day LINEARLY: one day is
 * `PX_PER_MIN * 1440` px and every consumer positions off that single scale.
 * The calendar view breaks that assumption on purpose — the owner wants
 * 00:00–07:00 and 21:00–24:00 collapsed to thin bars by default, each with an
 * expander. Once a region can shrink, `min * PX_PER_MIN` is no longer the pixel
 * of a minute, so this module becomes the SINGLE source of truth for the
 * calendar's vertical geometry and every consumer (block top/height, now-line,
 * hour gutter, click-to-create) routes through it.
 *
 * The day is modelled as three ordered SEGMENTS:
 *   • top    [0, 420)     — 00:00–07:00, collapsible (default collapsed)
 *   • middle [420, 1260)  — 07:00–21:00, always expanded
 *   • bottom [1260, 1440) — 21:00–24:00, collapsible (default collapsed)
 *
 * A collapsed segment occupies a fixed `COLLAPSED_BAR_PX`; an expanded segment
 * occupies `minutes * pxPerMin`. `yOf`/`minAt` are inverses on expanded minutes;
 * on a collapsed bar `minAt` clamps to the nearest expanded minute so a click on
 * a bar never lands "inside" hidden time.
 *
 * This module is PURE (no DOM, no Solid) and heavily unit-tested — the
 * correctness of the whole feature is won here.
 */

/** 00:00–07:00 collapses. */
export const TOP_COLLAPSE_START = 0;
export const TOP_COLLAPSE_END = 7 * 60; // 420

/** 21:00–24:00 collapses. */
export const BOTTOM_COLLAPSE_START = 21 * 60; // 1260
export const BOTTOM_COLLAPSE_END = 24 * 60; // 1440

/** Minutes in a full day. */
export const MINUTES_PER_DAY = 24 * 60;

/** Fixed pixel height of a collapsed region's thin bar. */
export const COLLAPSED_BAR_PX = 24;

/** Which collapsible region a segment represents (or `null` for the always-on middle). */
export type Region = 'top' | 'bottom';

/** Per-session expand state for the two collapsible regions. */
export interface AxisState {
  /** top region (00:00–07:00) expanded? default false (collapsed). */
  topExpanded: boolean;
  /** bottom region (21:00–24:00) expanded? default false (collapsed). */
  bottomExpanded: boolean;
  /** Configurable end of the top collapse region (minute-of-day). Absent →
   *  TOP_COLLAPSE_END (07:00). Persisted per-view in view_prefs (planner). */
  topEndMin?: number;
  /** Configurable start of the bottom collapse region (minute-of-day). Absent →
   *  BOTTOM_COLLAPSE_START (21:00). */
  bottomStartMin?: number;
}

/** Smallest always-expanded middle we guarantee between the two collapse regions. */
export const MIN_MIDDLE_MIN = 60;

/**
 * The effective collapse boundaries for a state — the user-configurable fields
 * clamped to sane halves of the day (top ends by noon, bottom starts from noon).
 * The bottom start is additionally kept at least `MIN_MIDDLE_MIN` after the top end,
 * so the always-expanded middle segment can never invert or vanish — even at the
 * extreme where both are set to noon. Every geometry consumer (segments/visibleExtent
 * and the components' boundary checks) reads THESE, so a state without the optional
 * fields behaves byte-identically to the old constants.
 */
export function topCollapseEnd(state: AxisState): number {
  const v = state.topEndMin;
  if (typeof v !== 'number' || !Number.isFinite(v)) return TOP_COLLAPSE_END;
  return Math.min(Math.max(Math.round(v), 0), 12 * 60);
}
export function bottomCollapseStart(state: AxisState): number {
  const v = state.bottomStartMin;
  const raw =
    typeof v !== 'number' || !Number.isFinite(v)
      ? BOTTOM_COLLAPSE_START
      : Math.min(Math.max(Math.round(v), 12 * 60), MINUTES_PER_DAY);
  // Keep a non-empty middle: never let the bottom region start before topEnd + MIN.
  // topEnd ≤ 720, so this floor stays ≤ 780 — well within the day.
  return Math.min(Math.max(raw, topCollapseEnd(state) + MIN_MIDDLE_MIN), MINUTES_PER_DAY);
}

/** Both regions collapsed — the calendar's default. */
export const DEFAULT_AXIS_STATE: AxisState = { topExpanded: false, bottomExpanded: false };

/** A laid-out vertical segment of the day axis. */
export interface Segment {
  /** Which collapsible region this is, or null for the always-expanded middle. */
  region: Region | null;
  /** Inclusive-start minute-of-day. */
  startMin: number;
  /** Exclusive-end minute-of-day. */
  endMin: number;
  /** Is this segment currently collapsed to a thin bar? */
  collapsed: boolean;
  /** Pixel Y where this segment begins. */
  topPx: number;
  /** Pixel height this segment occupies. */
  heightPx: number;
}

/**
 * Compute the ordered segment list for a given zoom (`pxPerMin`) and expand
 * state. The three segments are always present and contiguous; a collapsed one
 * simply has `heightPx === COLLAPSED_BAR_PX` instead of `minutes * pxPerMin`.
 */
export function segments(state: AxisState, pxPerMin: number): Segment[] {
  const topEnd = topCollapseEnd(state);
  const bottomStart = bottomCollapseStart(state);
  const specs: { region: Region | null; startMin: number; endMin: number; collapsed: boolean }[] = [
    { region: 'top', startMin: TOP_COLLAPSE_START, endMin: topEnd, collapsed: !state.topExpanded },
    { region: null, startMin: topEnd, endMin: bottomStart, collapsed: false },
    { region: 'bottom', startMin: bottomStart, endMin: BOTTOM_COLLAPSE_END, collapsed: !state.bottomExpanded },
  ];

  const out: Segment[] = [];
  let cursor = 0;
  for (const s of specs) {
    const heightPx = s.collapsed ? COLLAPSED_BAR_PX : (s.endMin - s.startMin) * pxPerMin;
    out.push({ ...s, topPx: cursor, heightPx });
    cursor += heightPx;
  }
  return out;
}

/** Total pixel height of the axis for the given state + zoom. */
export function axisHeightPx(state: AxisState, pxPerMin: number): number {
  const segs = segments(state, pxPerMin);
  const last = segs[segs.length - 1];
  return last.topPx + last.heightPx;
}

/** Find the segment that owns a minute-of-day (clamped into [0, 1440]). */
function segmentOf(min: number, segs: Segment[]): Segment {
  const m = Math.min(Math.max(min, 0), MINUTES_PER_DAY);
  // The last segment is half-open at 1440 but a minute exactly at 1440 belongs to it.
  for (const s of segs) {
    if (m >= s.startMin && m < s.endMin) return s;
  }
  return segs[segs.length - 1];
}

/**
 * Minute-of-day → pixel Y. For an EXPANDED segment this is exact (`topPx +
 * (min - startMin) * pxPerMin`). For a COLLAPSED segment the whole region maps
 * *proportionally* into its thin bar, so the mapping stays monotonic and a
 * boundary minute (e.g. 07:00) lands exactly at the bar's edge — where the
 * expanded region begins.
 */
export function yOf(min: number, state: AxisState, pxPerMin: number): number {
  // Clamp to the day range: callers can pass out-of-range minutes for blocks that
  // span midnight (minutesIntoDay), and using the raw value below would push Y
  // negative or past the axis, breaking monotonicity.
  const m = Math.min(Math.max(min, 0), MINUTES_PER_DAY);
  const segs = segments(state, pxPerMin);
  const seg = segmentOf(m, segs);
  const span = seg.endMin - seg.startMin;
  if (seg.collapsed) {
    // Proportional placement inside the fixed bar (monotonic; 0 at start, bar height at end).
    const frac = span > 0 ? (m - seg.startMin) / span : 0;
    return seg.topPx + frac * seg.heightPx;
  }
  return seg.topPx + (m - seg.startMin) * pxPerMin;
}

/**
 * Pixel Y → minute-of-day (inverse of `yOf`). If `y` lands inside a COLLAPSED
 * bar the result is clamped to the nearest EXPANDED minute — the region's
 * expanded-facing boundary — so a click on a thin bar never resolves to a hidden
 * minute (callers use this for click-to-create; you can't create inside collapsed
 * time without expanding first).
 */
export function minAt(y: number, state: AxisState, pxPerMin: number): number {
  const segs = segments(state, pxPerMin);
  // Total axis height straight from the segments we already have (they're contiguous),
  // avoiding a second segments() build via axisHeightPx on every pointer move.
  const last = segs[segs.length - 1];
  const total = last.topPx + last.heightPx;
  const py = Math.min(Math.max(y, 0), total);

  for (const seg of segs) {
    const segBottom = seg.topPx + seg.heightPx;
    // Own a pixel that falls within [topPx, bottom); the final segment also owns its bottom edge.
    const isLast = seg === segs[segs.length - 1];
    if (py < segBottom || (isLast && py <= segBottom)) {
      if (seg.collapsed) {
        // Clamp to the nearest expanded minute: the top region snaps DOWN to its
        // end (07:00), the bottom region snaps UP to its start (21:00). Either way
        // we hand back the expanded-facing boundary of the collapsed region.
        return seg.region === 'top' ? seg.endMin : seg.startMin;
      }
      const min = seg.startMin + (py - seg.topPx) / pxPerMin;
      return Math.min(Math.max(min, seg.startMin), seg.endMin);
    }
  }
  return MINUTES_PER_DAY;
}

/**
 * Visibility + clamping for a block's [startMin, endMin) extent under a state.
 * Returns `null` when the block lies ENTIRELY inside a collapsed region (hide it
 * until the region expands). Otherwise returns the clamped-to-visible extent: a
 * block spanning a boundary is trimmed to its expanded portion so it never bleeds
 * into a thin bar.
 */
export function visibleExtent(
  startMin: number,
  endMin: number,
  state: AxisState,
): { startMin: number; endMin: number } | null {
  // The union of currently-collapsed ranges (state-configurable boundaries).
  const topEnd = topCollapseEnd(state);
  const bottomStart = bottomCollapseStart(state);
  const collapsedRanges: [number, number][] = [];
  if (!state.topExpanded) collapsedRanges.push([TOP_COLLAPSE_START, topEnd]);
  if (!state.bottomExpanded) collapsedRanges.push([bottomStart, BOTTOM_COLLAPSE_END]);

  // Clamp into the day range so a block that runs past midnight (endMin > 1440)
  // is still trimmed/hidden correctly and never feeds out-of-range minutes to yOf.
  let s = Math.min(Math.max(startMin, 0), MINUTES_PER_DAY);
  let e = Math.min(Math.max(endMin, 0), MINUTES_PER_DAY);

  for (const [cs, ce] of collapsedRanges) {
    // Entirely inside a collapsed range → hidden.
    if (s >= cs && e <= ce) return null;
    // Overlaps the top collapse from below: trim the leading hidden part.
    if (cs === TOP_COLLAPSE_START && s < ce && e > ce) s = Math.max(s, ce);
    // Overlaps the bottom collapse from above: trim the trailing hidden part.
    if (ce === BOTTOM_COLLAPSE_END && e > cs && s < cs) e = Math.min(e, cs);
  }

  if (e <= s) return null;
  return { startMin: s, endMin: e };
}
