import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveGesture,
  commitDrag,
  isImmovable,
  setOverride,
  clearOverride,
  effectiveBlock,
  overrides,
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
