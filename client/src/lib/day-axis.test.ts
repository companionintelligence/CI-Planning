import { describe, it, expect } from 'vitest';
import {
  TOP_COLLAPSE_END,
  BOTTOM_COLLAPSE_START,
  BOTTOM_COLLAPSE_END,
  MINUTES_PER_DAY,
  COLLAPSED_BAR_PX,
  DEFAULT_AXIS_STATE,
  type AxisState,
  segments,
  axisHeightPx,
  yOf,
  minAt,
  visibleExtent,
} from './day-axis.js';

// The calendar renders expanded minutes at the app's PX_PER_MIN scale; the pure
// module is scale-agnostic so we test at a couple of zooms.
const PX = 1.28;

const BOTH_COLLAPSED: AxisState = { topExpanded: false, bottomExpanded: false };
const BOTH_EXPANDED: AxisState = { topExpanded: true, bottomExpanded: true };
const TOP_ONLY: AxisState = { topExpanded: true, bottomExpanded: false };
const BOTTOM_ONLY: AxisState = { topExpanded: false, bottomExpanded: true };

const ALL_STATES: [string, AxisState][] = [
  ['both collapsed', BOTH_COLLAPSED],
  ['both expanded', BOTH_EXPANDED],
  ['top only', TOP_ONLY],
  ['bottom only', BOTTOM_ONLY],
];

describe('day-axis — default state', () => {
  it('defaults to both regions collapsed', () => {
    expect(DEFAULT_AXIS_STATE).toEqual({ topExpanded: false, bottomExpanded: false });
  });
});

describe('day-axis — segments', () => {
  it('always yields three contiguous ordered segments covering the whole day', () => {
    for (const [, state] of ALL_STATES) {
      const segs = segments(state, PX);
      expect(segs).toHaveLength(3);
      expect(segs[0].startMin).toBe(0);
      expect(segs[2].endMin).toBe(MINUTES_PER_DAY);
      // Contiguous in both minutes and pixels.
      for (let i = 1; i < segs.length; i++) {
        expect(segs[i].startMin).toBe(segs[i - 1].endMin);
        expect(segs[i].topPx).toBeCloseTo(segs[i - 1].topPx + segs[i - 1].heightPx, 9);
      }
    }
  });

  it('collapsed segments are a fixed thin bar; expanded scale with pxPerMin', () => {
    const segs = segments(BOTH_COLLAPSED, PX);
    expect(segs[0].collapsed).toBe(true);
    expect(segs[0].heightPx).toBe(COLLAPSED_BAR_PX);
    expect(segs[2].collapsed).toBe(true);
    expect(segs[2].heightPx).toBe(COLLAPSED_BAR_PX);
    // The middle is always expanded.
    expect(segs[1].collapsed).toBe(false);
    expect(segs[1].heightPx).toBeCloseTo((BOTTOM_COLLAPSE_START - TOP_COLLAPSE_END) * PX, 9);
  });

  it('expanding a region turns its bar back into a 1px/min region', () => {
    const segs = segments(TOP_ONLY, PX);
    expect(segs[0].collapsed).toBe(false);
    expect(segs[0].heightPx).toBeCloseTo(TOP_COLLAPSE_END * PX, 9);
    expect(segs[2].collapsed).toBe(true); // bottom still collapsed
  });

  it('the middle region is never collapsible', () => {
    for (const [, state] of ALL_STATES) {
      expect(segments(state, PX)[1].collapsed).toBe(false);
    }
  });
});

describe('day-axis — axisHeightPx', () => {
  it('a fully expanded axis is the linear full-day height', () => {
    expect(axisHeightPx(BOTH_EXPANDED, PX)).toBeCloseTo(MINUTES_PER_DAY * PX, 9);
  });

  it('collapsing shrinks the axis (each collapse saves region-minutes − bar)', () => {
    const full = axisHeightPx(BOTH_EXPANDED, PX);
    const topSaving = TOP_COLLAPSE_END * PX - COLLAPSED_BAR_PX;
    const bottomSaving = (BOTTOM_COLLAPSE_END - BOTTOM_COLLAPSE_START) * PX - COLLAPSED_BAR_PX;
    expect(axisHeightPx(TOP_ONLY, PX)).toBeCloseTo(full - bottomSaving, 9);
    expect(axisHeightPx(BOTTOM_ONLY, PX)).toBeCloseTo(full - topSaving, 9);
    expect(axisHeightPx(BOTH_COLLAPSED, PX)).toBeCloseTo(full - topSaving - bottomSaving, 9);
    // Both-collapsed is the shortest.
    expect(axisHeightPx(BOTH_COLLAPSED, PX)).toBeLessThan(axisHeightPx(TOP_ONLY, PX));
    expect(axisHeightPx(BOTH_COLLAPSED, PX)).toBeLessThan(axisHeightPx(BOTTOM_ONLY, PX));
  });
});

describe('day-axis — yOf / minAt round-trip on expanded minutes', () => {
  // For every state and both zooms, minAt(yOf(m)) ≈ m for minutes in EXPANDED regions.
  for (const [name, state] of ALL_STATES) {
    for (const px of [1, PX, 2]) {
      it(`round-trips expanded minutes (${name}, ${px}px/min)`, () => {
        const expandedMinutes: number[] = [];
        // middle is always expanded
        expandedMinutes.push(420, 500, 720, 900, 1200, 1259);
        if (state.topExpanded) expandedMinutes.push(0, 15, 120, 419);
        if (state.bottomExpanded) expandedMinutes.push(1260, 1300, 1439);
        for (const m of expandedMinutes) {
          expect(minAt(yOf(m, state, px), state, px)).toBeCloseTo(m, 6);
        }
      });
    }
  }
});

describe('day-axis — yOf monotonicity', () => {
  it('yOf is non-decreasing across the whole day in every state', () => {
    for (const [, state] of ALL_STATES) {
      let prev = -Infinity;
      for (let m = 0; m <= MINUTES_PER_DAY; m += 5) {
        const y = yOf(m, state, PX);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = y;
      }
    }
  });
});

describe('day-axis — boundary minutes', () => {
  it('07:00 lands at the middle-segment top in every state', () => {
    for (const [, state] of ALL_STATES) {
      const segs = segments(state, PX);
      expect(yOf(TOP_COLLAPSE_END, state, PX)).toBeCloseTo(segs[1].topPx, 9);
    }
  });

  it('21:00 lands at the bottom-segment top in every state', () => {
    for (const [, state] of ALL_STATES) {
      const segs = segments(state, PX);
      expect(yOf(BOTTOM_COLLAPSE_START, state, PX)).toBeCloseTo(segs[2].topPx, 9);
    }
  });
});

describe('day-axis — minAt clamps on collapsed bars', () => {
  it('a click on the collapsed TOP bar resolves to 07:00 (region end)', () => {
    const segs = segments(BOTH_COLLAPSED, PX);
    const top = segs[0];
    // anywhere inside the top bar
    expect(minAt(top.topPx + 1, BOTH_COLLAPSED, PX)).toBe(TOP_COLLAPSE_END);
    expect(minAt(top.topPx + top.heightPx / 2, BOTH_COLLAPSED, PX)).toBe(TOP_COLLAPSE_END);
  });

  it('a click on the collapsed BOTTOM bar resolves to 21:00 (region start)', () => {
    const segs = segments(BOTH_COLLAPSED, PX);
    const bot = segs[2];
    expect(minAt(bot.topPx + 1, BOTH_COLLAPSED, PX)).toBe(BOTTOM_COLLAPSE_START);
    expect(minAt(bot.topPx + bot.heightPx / 2, BOTH_COLLAPSED, PX)).toBe(BOTTOM_COLLAPSE_START);
  });

  it('clamps y below 0 and above the axis into range', () => {
    expect(minAt(-50, BOTH_COLLAPSED, PX)).toBeGreaterThanOrEqual(0);
    expect(minAt(999999, BOTH_COLLAPSED, PX)).toBeLessThanOrEqual(MINUTES_PER_DAY);
  });
});

describe('day-axis — visibleExtent', () => {
  it('a block fully inside a collapsed region is hidden', () => {
    // 02:00–03:00 lives inside the collapsed top.
    expect(visibleExtent(120, 180, BOTH_COLLAPSED)).toBeNull();
    // 22:00–23:00 lives inside the collapsed bottom.
    expect(visibleExtent(1320, 1380, BOTH_COLLAPSED)).toBeNull();
  });

  it('the same blocks are fully visible once their region expands', () => {
    expect(visibleExtent(120, 180, TOP_ONLY)).toEqual({ startMin: 120, endMin: 180 });
    expect(visibleExtent(1320, 1380, BOTTOM_ONLY)).toEqual({ startMin: 1320, endMin: 1380 });
  });

  it('a block spanning the TOP boundary is trimmed to its expanded part', () => {
    // 06:00–09:00 → visible portion is 07:00–09:00 while top is collapsed.
    expect(visibleExtent(360, 540, BOTH_COLLAPSED)).toEqual({ startMin: TOP_COLLAPSE_END, endMin: 540 });
    // Fully expanded → untrimmed.
    expect(visibleExtent(360, 540, TOP_ONLY)).toEqual({ startMin: 360, endMin: 540 });
  });

  it('a block spanning the BOTTOM boundary is trimmed to its expanded part', () => {
    // 20:00–22:00 → visible portion is 20:00–21:00 while bottom is collapsed.
    expect(visibleExtent(1200, 1320, BOTH_COLLAPSED)).toEqual({ startMin: 1200, endMin: BOTTOM_COLLAPSE_START });
    expect(visibleExtent(1200, 1320, BOTTOM_ONLY)).toEqual({ startMin: 1200, endMin: 1320 });
  });

  it('a fully-visible middle block is returned unchanged in any state', () => {
    for (const [, state] of ALL_STATES) {
      expect(visibleExtent(600, 660, state)).toEqual({ startMin: 600, endMin: 660 });
    }
  });

  it('an all-day-ish block spanning both boundaries is trimmed to the middle when both collapsed', () => {
    // 00:00–24:00 → 07:00–21:00 visible.
    expect(visibleExtent(0, MINUTES_PER_DAY, BOTH_COLLAPSED)).toEqual({
      startMin: TOP_COLLAPSE_END,
      endMin: BOTTOM_COLLAPSE_START,
    });
  });
});
