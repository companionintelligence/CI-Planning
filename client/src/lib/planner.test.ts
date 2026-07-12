import { describe, it, expect } from 'vitest';
import { pickNextUp, segmentExtentPx, dragDeltaMin, inheritedBlockTag } from './planner.js';
import { instantFor } from './grid.js';
import {
  type AxisState,
  TOP_COLLAPSE_END,
  BOTTOM_COLLAPSE_START,
  COLLAPSED_BAR_PX,
  yOf as axisYOf,
} from './day-axis.js';

const PX = 1.28; // PX_PER_MIN — the app scale
const day = '2026-06-15';
const at = (mins: number) => instantFor(day, mins);
const blk = (startMin: number, endMin: number, status = 'planned') => ({
  start_at: at(startMin), end_at: at(endMin), status,
});

const BOTH_COLLAPSED: AxisState = { topExpanded: false, bottomExpanded: false };
const BOTH_EXPANDED: AxisState = { topExpanded: true, bottomExpanded: true };

describe('pickNextUp', () => {
  it('returns the earliest block whose end is still in the future', () => {
    const now = at(10 * 60); // 10:00 local
    const items = [blk(11 * 60, 12 * 60), blk(9 * 60, 9 * 60 + 30), blk(10 * 60 + 15, 11 * 60)];
    // 09:00–09:30 is fully past; next up is the 10:15 block, not the 11:00 one.
    expect(pickNextUp(items, now)?.start_at).toBe(at(10 * 60 + 15));
  });

  it('treats a block ending exactly now as past', () => {
    const now = at(10 * 60);
    const items = [blk(9 * 60, 10 * 60), blk(14 * 60, 15 * 60)];
    expect(pickNextUp(items, now)?.start_at).toBe(at(14 * 60));
  });

  it('skips completed / skipped / cancelled blocks', () => {
    const now = at(8 * 60);
    const items = [blk(9 * 60, 10 * 60, 'completed'), blk(9 * 60, 10 * 60, 'skipped'), blk(11 * 60, 12 * 60)];
    expect(pickNextUp(items, now)?.start_at).toBe(at(11 * 60));
  });

  it('returns undefined when the day is empty or fully behind', () => {
    const now = at(20 * 60);
    expect(pickNextUp([], now)).toBeUndefined();
    expect(pickNextUp([blk(9 * 60, 10 * 60)], now)).toBeUndefined();
  });
});

describe('segmentExtentPx — projecting a minute extent onto the segmented axis', () => {
  it('places a mid-day block at its exact segmented top/height when regions collapsed', () => {
    // 10:00–11:00 is in the always-expanded middle. Top = TOP bar + (10:00-07:00).
    const ext = segmentExtentPx(10 * 60, 11 * 60, BOTH_COLLAPSED, PX)!;
    expect(ext).not.toBeNull();
    expect(ext.topPx).toBeCloseTo(axisYOf(10 * 60, BOTH_COLLAPSED, PX), 9);
    expect(ext.heightPx).toBeCloseTo(60 * PX, 9); // one expanded hour
  });

  it('hides a block wholly inside a collapsed region', () => {
    // 02:00–03:00 is inside the collapsed top region → null (hidden until expanded).
    expect(segmentExtentPx(2 * 60, 3 * 60, BOTH_COLLAPSED, PX)).toBeNull();
    expect(segmentExtentPx(22 * 60, 23 * 60, BOTH_COLLAPSED, PX)).toBeNull();
  });

  it('reveals that block once its region is expanded', () => {
    const ext = segmentExtentPx(2 * 60, 3 * 60, BOTH_EXPANDED, PX)!;
    expect(ext.topPx).toBeCloseTo(2 * 60 * PX, 9);
    expect(ext.heightPx).toBeCloseTo(60 * PX, 9);
  });

  it('clamps a boundary-spanning block to its expanded portion', () => {
    // 06:00–08:00 spans the top collapse boundary (07:00). With top collapsed the
    // 06:00–07:00 part is hidden; the visible extent starts at 07:00.
    const ext = segmentExtentPx(6 * 60, 8 * 60, BOTH_COLLAPSED, PX)!;
    expect(ext.topPx).toBeCloseTo(axisYOf(TOP_COLLAPSE_END, BOTH_COLLAPSED, PX), 9);
    expect(ext.heightPx).toBeCloseTo(60 * PX, 9); // only the 07:00–08:00 hour
  });
});

describe('dragDeltaMin — segmented pixel→minute delta', () => {
  it('inside an expanded region equals the linear dyPx / pxPerMin', () => {
    // Fully expanded axis: y is linear, so a 60px * (1/PX) drag ≈ 60/PX minutes.
    const startY = axisYOf(10 * 60, BOTH_EXPANDED, PX); // pixel at 10:00
    const dyPx = 90 * PX;                               // 90 minutes' worth of px
    expect(dragDeltaMin(startY, dyPx, BOTH_EXPANDED, PX)).toBeCloseTo(90, 6);
  });

  it('within the always-expanded middle behaves linearly even when night is collapsed', () => {
    const startY = axisYOf(10 * 60, BOTH_COLLAPSED, PX);
    const dyPx = 45 * PX;
    expect(dragDeltaMin(startY, dyPx, BOTH_COLLAPSED, PX)).toBeCloseTo(45, 6);
  });

  it('dragging up into a collapsed top region clamps at the region edge (07:00)', () => {
    // Start at 07:30, drag up far past the collapsed top bar. minAt clamps a Y inside
    // the collapsed bar to 07:00, so the delta bottoms out at −30 min (07:30→07:00).
    const startY = axisYOf(7 * 60 + 30, BOTH_COLLAPSED, PX);
    const dyPx = -1000; // way up, into/above the thin top bar
    const delta = dragDeltaMin(startY, dyPx, BOTH_COLLAPSED, PX);
    expect(delta).toBeCloseTo(TOP_COLLAPSE_END - (7 * 60 + 30), 6); // −30
  });

  it('dragging down into a collapsed bottom region clamps at the region edge (21:00)', () => {
    const startY = axisYOf(20 * 60 + 30, BOTH_COLLAPSED, PX);
    const dyPx = 1000; // way down, into/below the thin bottom bar
    const delta = dragDeltaMin(startY, dyPx, BOTH_COLLAPSED, PX);
    expect(delta).toBeCloseTo(BOTTOM_COLLAPSE_START - (20 * 60 + 30), 6); // +30
  });

  it('a zero-pixel drag is a zero-minute delta (byte-identical round trip)', () => {
    const startY = axisYOf(13 * 60, BOTH_COLLAPSED, PX);
    expect(dragDeltaMin(startY, 0, BOTH_COLLAPSED, PX)).toBe(0);
    // The collapsed bar height is fixed; sanity that the constant is present.
    expect(COLLAPSED_BAR_PX).toBeGreaterThan(0);
  });
});

describe('inheritedBlockTag — AF-11 grid-created block inherits the task PRIMARY', () => {
  it('returns the level-1 direction (tags[] is L1-only post-split)', () => {
    expect(inheritedBlockTag({ tags: ['work'] })).toBe('work');
  });
  it('a direction-less task (intentions only live in secondary_tags) yields undefined — block is untagged', () => {
    expect(inheritedBlockTag({ tags: [] })).toBeUndefined();
  });
  it('unknown task yields undefined', () => {
    expect(inheritedBlockTag(undefined)).toBeUndefined();
  });
});
