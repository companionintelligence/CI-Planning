import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveGesture,
  commitDrag,
  isImmovable,
  setOverride,
  clearOverride,
  effectiveBlock,
  overrides,
  clampLiveDelta,
  HANDLE_PX,
  MIN_DURATION_MIN,
} from './drag.js';
import { PX_PER_MIN, minutesIntoDay, instantFor } from './grid.js';
import type { Block } from './api.js';

// TZ=America/Los_Angeles is pinned in vitest.config.ts. A 09:00–10:00 PDT block
// on 2026-06-15 is 16:00–17:00 UTC.
const DAY = '2026-06-15';
function block(overrides: Partial<Block> = {}): Block {
  return {
    id: 1,
    title: 'Focus',
    block_kind: 'focus',
    start_at: '2026-06-15T16:00:00.000Z', // 09:00 PDT
    end_at: '2026-06-15T17:00:00.000Z', // 10:00 PDT
    is_locked: false,
    is_auto: false,
    source_kind: 'manual',
    status: 'planned',
    created_at: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  // Reset the shared override map between tests.
  for (const id of Object.keys(overrides()).map(Number)) clearOverride(id);
});

describe('resolveGesture — no tz drift', () => {
  it('a 0px move produces byte-identical start/end instants', () => {
    const b = block();
    const r = resolveGesture(b, DAY, 'move', 0);
    expect(r).not.toBeNull();
    expect(r!.start_at).toBe(b.start_at); // byte-identical
    expect(r!.end_at).toBe(b.end_at);
  });

  it('a +1h move shifts exactly 60 minutes and round-trips', () => {
    const b = block();
    const dyPx = 60 * PX_PER_MIN; // one hour of pixels
    const r = resolveGesture(b, DAY, 'move', dyPx)!;
    // Exactly 60 real minutes later, both edges.
    expect(minutesIntoDay(r.start_at, DAY) - minutesIntoDay(b.start_at, DAY)).toBe(60);
    expect(minutesIntoDay(r.end_at, DAY) - minutesIntoDay(b.end_at, DAY)).toBe(60);
    // And the instants are exactly the +1h UTC instants (no drift).
    expect(r.start_at).toBe('2026-06-15T17:00:00.000Z');
    expect(r.end_at).toBe('2026-06-15T18:00:00.000Z');
  });

  it('snaps a sub-snap pixel jitter to the nearest SNAP_MIN', () => {
    const b = block();
    // 7px ≈ 8.75 min → snaps to 15? No: minsOf rounds to nearest 15 → 7px = 8.75min → 15.
    const r = resolveGesture(b, DAY, 'move', 7)!;
    const delta = minutesIntoDay(r.start_at, DAY) - minutesIntoDay(b.start_at, DAY);
    expect(delta % 15).toBe(0); // always snapped
  });
});

describe('resolveGesture — resize clamp + no-invert', () => {
  it('resizing the bottom up below MIN_DURATION clamps, never inverts', () => {
    const b = block(); // 60 min long
    // Drag the bottom edge way up past the top (−120 min of pixels).
    const r = resolveGesture(b, DAY, 'resize-bottom', -120 * PX_PER_MIN)!;
    const dur = minutesIntoDay(r.end_at, DAY) - minutesIntoDay(r.start_at, DAY);
    expect(dur).toBe(MIN_DURATION_MIN); // clamped to minimum, not negative
    expect(r.start_at).toBe(b.start_at); // top unchanged for a bottom-resize
  });

  it('resizing the top down past the bottom clamps, never inverts', () => {
    const b = block();
    const r = resolveGesture(b, DAY, 'resize-top', 120 * PX_PER_MIN)!;
    const dur = minutesIntoDay(r.end_at, DAY) - minutesIntoDay(r.start_at, DAY);
    expect(dur).toBe(MIN_DURATION_MIN);
    expect(r.end_at).toBe(b.end_at); // bottom unchanged for a top-resize
  });

  it('a normal bottom-resize +30m extends the block', () => {
    const b = block();
    const r = resolveGesture(b, DAY, 'resize-bottom', 30 * PX_PER_MIN)!;
    const dur = minutesIntoDay(r.end_at, DAY) - minutesIntoDay(r.start_at, DAY);
    expect(dur).toBe(90);
  });
});

describe('resolveGesture — neighbour collision clamp', () => {
  // Base block is 09:00–10:00 PDT = 540–600 minutes into the day.
  const px = (min: number) => min * PX_PER_MIN;
  const mins = (iso: string) => minutesIntoDay(iso, DAY);

  it('a downward move stops flush at the neighbour below (duration preserved)', () => {
    const b = block();
    const below = [{ topMin: 660, botMin: 720 }]; // 11:00–12:00
    const r = resolveGesture(b, DAY, 'move', px(120), below)!; // would land 660–720
    expect(mins(r.start_at)).toBe(600);   // clamped: bottom flush at 660
    expect(mins(r.end_at)).toBe(660);
    expect(mins(r.end_at) - mins(r.start_at)).toBe(60); // duration preserved
  });

  it('an upward move stops flush at the neighbour above', () => {
    const b = block();
    const above = [{ topMin: 420, botMin: 480 }]; // 07:00–08:00
    const r = resolveGesture(b, DAY, 'move', px(-120), above)!; // would land 420–480
    expect(mins(r.start_at)).toBe(480);   // top flush at the neighbour's bottom
    expect(mins(r.end_at)).toBe(540);
  });

  it('a non-adjacent neighbour does not constrain a smaller move', () => {
    const b = block();
    const below = [{ topMin: 660, botMin: 720 }];
    const r = resolveGesture(b, DAY, 'move', px(30), below)!; // 540→570, well clear
    expect(mins(r.start_at)).toBe(570);
    expect(mins(r.end_at)).toBe(630);
  });

  it('resize-bottom clamps to the neighbour top and never past MIN_DURATION', () => {
    const b = block();
    const below = [{ topMin: 660, botMin: 720 }];
    const r = resolveGesture(b, DAY, 'resize-bottom', px(180), below)!; // would extend to 780
    expect(mins(r.start_at)).toBe(540);   // top unchanged
    expect(mins(r.end_at)).toBe(660);     // clamped to neighbour top
  });

  it('resize-top clamps to the neighbour bottom', () => {
    const b = block();
    const above = [{ topMin: 420, botMin: 480 }];
    const r = resolveGesture(b, DAY, 'resize-top', px(-180), above)!; // would extend to 360
    expect(mins(r.start_at)).toBe(480);   // clamped to neighbour bottom
    expect(mins(r.end_at)).toBe(600);     // bottom unchanged
  });

  it("don't-worsen: an already-overlapping block can't be moved deeper but can move out", () => {
    const b = block();
    const straddle = [{ topMin: 580, botMin: 640 }]; // overlaps the 540–600 block by 20m
    // Moving down would deepen the overlap → fully blocked (no shift).
    const deeper = resolveGesture(b, DAY, 'move', px(60), straddle)!;
    expect(mins(deeper.start_at)).toBe(540);
    expect(mins(deeper.end_at)).toBe(600);
    // Moving up reduces the overlap → allowed.
    const out = resolveGesture(b, DAY, 'move', px(-60), straddle)!;
    expect(mins(out.start_at)).toBe(480);
    expect(mins(out.end_at)).toBe(540);
  });

  it('empty neighbours reproduces the unclamped result byte-for-byte', () => {
    const b = block();
    const clamped = resolveGesture(b, DAY, 'move', px(120), []);
    const legacy = resolveGesture(b, DAY, 'move', px(120));
    expect(clamped).toEqual(legacy);
    expect(clamped!.start_at).toBe('2026-06-15T18:00:00.000Z'); // 11:00 PDT, unclamped
  });

  it('clamps correctly across the spring-forward DST boundary (minute-space)', () => {
    const dstDay = '2026-03-08';
    // 10:00–10:30 local PDT == 17:00–17:30 UTC == 540–570 minutes into the day.
    const b = block({ start_at: '2026-03-08T17:00:00.000Z', end_at: '2026-03-08T17:30:00.000Z' });
    const below = [{ topMin: 600, botMin: 660 }]; // 11:00–12:00 local
    const r = resolveGesture(b, dstDay, 'move', 120 * PX_PER_MIN, below)!; // clamp delta to 30m
    expect(minutesIntoDay(r.start_at, dstDay)).toBe(570);
    expect(minutesIntoDay(r.end_at, dstDay)).toBe(600); // flush at the neighbour, DST-safe
  });
});

describe('clampLiveDelta — live preview clamp (unsnapped)', () => {
  it('clamps a live move to the neighbour edge without snapping the in-between motion', () => {
    const b = block(); // 540–600
    const below = [{ topMin: 660, botMin: 720 }];
    expect(clampLiveDelta(b, DAY, 'move', 100, below)).toBe(60); // stops flush (660−600)
    expect(clampLiveDelta(b, DAY, 'move', 37, below)).toBe(37);   // clear → unsnapped, not 30/45
  });

  it('clamps a live resize-bottom to the neighbour edge', () => {
    const b = block();
    const below = [{ topMin: 660, botMin: 720 }];
    expect(clampLiveDelta(b, DAY, 'resize-bottom', 100, below)).toBe(60); // newBot 700 → 660
  });

  it('is unconstrained with no neighbours', () => {
    const b = block();
    expect(clampLiveDelta(b, DAY, 'move', 42, [])).toBe(42);
  });
});

describe('resolveGesture — locked / meeting reject', () => {
  it('returns null for is_locked blocks', () => {
    expect(resolveGesture(block({ is_locked: true }), DAY, 'move', 60)).toBeNull();
  });
  it('returns null for meeting blocks', () => {
    expect(resolveGesture(block({ block_kind: 'meeting' }), DAY, 'move', 60)).toBeNull();
  });
  it('isImmovable flags both', () => {
    expect(isImmovable(block({ is_locked: true }))).toBe(true);
    expect(isImmovable(block({ block_kind: 'meeting' }))).toBe(true);
    expect(isImmovable(block())).toBe(false);
  });
});

describe('commitDrag — one PATCH per gesture', () => {
  it('emits exactly one PATCH on commit with the resolved instants', async () => {
    const b = block();
    const calls: { id: number; body: Partial<Block> }[] = [];
    const resolved = resolveGesture(b, DAY, 'move', 60 * PX_PER_MIN);
    await commitDrag(b, resolved, { update: async (id, body) => { calls.push({ id, body }); } });
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe(1);
    expect(calls[0].body.start_at).toBe('2026-06-15T17:00:00.000Z');
    expect(calls[0].body.end_at).toBe('2026-06-15T18:00:00.000Z');
  });

  it('emits NO PATCH for a locked block (null resolution)', async () => {
    const b = block({ is_locked: true });
    const calls: unknown[] = [];
    const resolved = resolveGesture(b, DAY, 'move', 60); // null
    const ok = await commitDrag(b, resolved, { update: async () => { calls.push(1); } });
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('emits NO PATCH for a meeting block', async () => {
    const b = block({ block_kind: 'meeting' });
    const calls: unknown[] = [];
    const resolved = resolveGesture(b, DAY, 'move', 60);
    await commitDrag(b, resolved, { update: async () => { calls.push(1); } });
    expect(calls.length).toBe(0);
  });
});

describe('optimistic override map', () => {
  it('effectiveBlock shows the override immediately, authoritative row otherwise', () => {
    const b = block();
    expect(effectiveBlock(b).start_at).toBe(b.start_at); // no override yet
    setOverride(b.id, { start_at: '2026-06-15T18:00:00.000Z', end_at: '2026-06-15T19:00:00.000Z' });
    expect(effectiveBlock(b).start_at).toBe('2026-06-15T18:00:00.000Z'); // override wins
    expect(effectiveBlock(b).end_at).toBe('2026-06-15T19:00:00.000Z');
  });

  it('commitDrag sets the override optimistically and keeps it on success', async () => {
    const b = block();
    const resolved = resolveGesture(b, DAY, 'move', 60 * PX_PER_MIN)!;
    await commitDrag(b, resolved, { update: async () => {} });
    expect(effectiveBlock(b).start_at).toBe(resolved.start_at); // override stands until SSE
  });

  it('SSE refetch supersedes the override (idempotent clear by id)', async () => {
    const b = block();
    const resolved = resolveGesture(b, DAY, 'move', 60 * PX_PER_MIN)!;
    await commitDrag(b, resolved, { update: async () => {} });
    expect(effectiveBlock(b).start_at).toBe(resolved.start_at);
    // Authoritative row arrives (block:updated → refetch); the store clears the
    // override by id. Clearing twice is a no-op.
    clearOverride(b.id);
    clearOverride(b.id); // idempotent
    const fresh = block({ start_at: resolved.start_at, end_at: resolved.end_at });
    expect(effectiveBlock(fresh).start_at).toBe(resolved.start_at); // now from the row itself
    expect(overrides()[b.id]).toBeUndefined();
  });

  it('rolls back the override and reports the error when the PATCH fails', async () => {
    const b = block();
    const resolved = resolveGesture(b, DAY, 'move', 60 * PX_PER_MIN)!;
    let errMsg = '';
    await commitDrag(b, resolved, {
      update: async () => { throw new Error('boom'); },
      onError: (m) => { errMsg = m; },
    });
    expect(errMsg).toBe('boom');
    expect(overrides()[b.id]).toBeUndefined(); // rolled back
    expect(effectiveBlock(b).start_at).toBe(b.start_at); // original position restored
  });
});

describe('handle geometry', () => {
  it('exposes a 6px handle constant for the chip edges', () => {
    expect(HANDLE_PX).toBe(6);
  });
});
