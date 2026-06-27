import { describe, it, expect } from 'vitest';
import { shiftBlock, applyGroupDelta, resolveGroup, containerAt, clampGroupDelta } from './group-move.js';
import { instantFor, minutesIntoDay } from './grid.js';
import type { Block } from './api.js';

/**
 * Pure grouped-movement math (PR-C). The invariant under test: a group move is a
 * single minute delta applied to every member via `instantFor`, so it preserves
 * every relative offset + duration, has no tz drift, and is the identity at delta 0
 * — matching the server's pure elapsed-ms `move-group` shift.
 */
const day = '2026-06-22';
const at = (mins: number) => instantFor(day, mins);
const ms = (iso: string) => Date.parse(iso);

// Minimal Block fixtures — only the fields the math reads.
const mk = (p: Partial<Block>): Block => ({
  id: 0, title: 't', block_kind: 'task', start_at: at(0), end_at: at(60),
  is_locked: false, is_auto: true, source_kind: 'manual', status: 'planned', created_at: '', ...p,
});

describe('shiftBlock', () => {
  it('is the identity at delta 0 (byte-identical instants)', () => {
    const b = mk({ start_at: at(540), end_at: at(600) });
    const r = shiftBlock(b, day, 0);
    expect(r.start_at).toBe(b.start_at);
    expect(r.end_at).toBe(b.end_at);
  });

  it('shifts both edges by exactly delta·60000 ms (positive + negative)', () => {
    const b = mk({ start_at: at(540), end_at: at(630) });
    for (const d of [30, -75, 195, -1, 1440]) {
      const r = shiftBlock(b, day, d);
      expect(ms(r.start_at) - ms(b.start_at)).toBe(d * 60_000);
      expect(ms(r.end_at) - ms(b.end_at)).toBe(d * 60_000);
      expect(ms(r.end_at) - ms(r.start_at)).toBe(ms(b.end_at) - ms(b.start_at)); // duration preserved
    }
  });

  it('round-trips: shift +d then −d returns the original instants', () => {
    const b = mk({ start_at: at(480), end_at: at(525) });
    const there = shiftBlock(b, day, 137);
    const back = shiftBlock(mk({ start_at: there.start_at, end_at: there.end_at }), day, -137);
    expect(back.start_at).toBe(b.start_at);
    expect(back.end_at).toBe(b.end_at);
  });

  it('no tz drift across a US spring-forward day (pure ms, duration intact)', () => {
    const dstDay = '2026-03-08';
    const b = mk({ start_at: instantFor(dstDay, 60), end_at: instantFor(dstDay, 240) }); // spans the 02:00 jump
    const r = shiftBlock(b, dstDay, 45);
    expect(ms(r.start_at) - ms(b.start_at)).toBe(45 * 60_000);
    expect(ms(r.end_at) - ms(b.end_at)).toBe(45 * 60_000);
    expect(ms(r.end_at) - ms(r.start_at)).toBe(ms(b.end_at) - ms(b.start_at));
  });
});

describe('applyGroupDelta', () => {
  it('shifts every member by the delta and preserves their relative offsets, keyed by id', () => {
    const plan = mk({ id: 1, block_kind: 'timeblock', start_at: at(540), end_at: at(720) });
    const a = mk({ id: 2, parent_block_id: 1, start_at: at(540), end_at: at(600) });
    const b = mk({ id: 3, parent_block_id: 1, start_at: at(630), end_at: at(660) });
    const moves = applyGroupDelta([plan, a, b], day, 30);

    expect(Object.keys(moves).map(Number).sort()).toEqual([1, 2, 3]);
    expect(moves[1].start_at).toBe(at(570));
    expect(moves[2].start_at).toBe(at(570));
    expect(moves[3].start_at).toBe(at(660));
    // offset a→b (90 min) and a→plan (0) unchanged
    expect(ms(moves[3].start_at) - ms(moves[2].start_at)).toBe(90 * 60_000);
    expect(ms(moves[2].start_at) - ms(moves[1].start_at)).toBe(0);
  });

  it('delta 0 leaves every member byte-identical', () => {
    const members = [mk({ id: 1, start_at: at(540), end_at: at(600) }), mk({ id: 2, start_at: at(630), end_at: at(700) })];
    const moves = applyGroupDelta(members, day, 0);
    for (const m of members) { expect(moves[m.id].start_at).toBe(m.start_at); expect(moves[m.id].end_at).toBe(m.end_at); }
  });
});

describe('resolveGroup', () => {
  const plan = mk({ id: 1, block_kind: 'timeblock' });
  const a = mk({ id: 2, parent_block_id: 1 });
  const b = mk({ id: 3, parent_block_id: 1 });
  const loose = mk({ id: 4 });
  const other = mk({ id: 5, block_kind: 'timeblock' });
  const all = [plan, a, b, loose, other];

  it('from the container anchor → the container + all its children', () => {
    expect(resolveGroup(all, 1).map((x) => x.id).sort()).toEqual([1, 2, 3]);
  });
  it('from any member anchor → the whole group identically', () => {
    expect(resolveGroup(all, 2).map((x) => x.id).sort()).toEqual([1, 2, 3]);
    expect(resolveGroup(all, 3).map((x) => x.id).sort()).toEqual([1, 2, 3]);
  });
  it('a loose block is its own singleton group', () => {
    expect(resolveGroup(all, 4).map((x) => x.id)).toEqual([4]);
  });
  it('an unknown anchor resolves to nothing', () => {
    expect(resolveGroup(all, 999)).toEqual([]);
  });
});

describe('clampGroupDelta — whole-group collision clamp', () => {
  // Group hull = [540, 720] (plan 09:00–12:00 with two children inside).
  const plan = mk({ id: 1, block_kind: 'timeblock', start_at: at(540), end_at: at(720) });
  const a = mk({ id: 2, parent_block_id: 1, start_at: at(540), end_at: at(600) });
  const b = mk({ id: 3, parent_block_id: 1, start_at: at(630), end_at: at(660) });
  const members = [plan, a, b];

  it('clamps a downward move so the hull stops flush at the nearest trailing obstacle', () => {
    const below = mk({ id: 9, start_at: at(780), end_at: at(840) }); // 13:00–14:00
    expect(clampGroupDelta(members, [...members, below], day, 120)).toBe(60); // 780−720
  });

  it('clamps a backward move so the hull stops flush at the nearest leading obstacle', () => {
    const above = mk({ id: 9, start_at: at(420), end_at: at(480) }); // 07:00–08:00
    expect(clampGroupDelta(members, [...members, above], day, -120)).toBe(-60); // 540−480
  });

  it('passes the delta through untouched when there is no obstacle', () => {
    expect(clampGroupDelta(members, members, day, 200)).toBe(200);
    expect(clampGroupDelta(members, members, day, -200)).toBe(-200);
    expect(clampGroupDelta(members, members, day, 0)).toBe(0);
  });

  it('never treats a member as an obstacle (internal overlaps move rigidly)', () => {
    // Even with overlapping children, the hull move is unconstrained by its own members.
    expect(clampGroupDelta(members, members, day, 90)).toBe(90);
  });

  it('excludes all-day blocks from the obstacle set', () => {
    const allDayBelow = mk({ id: 9, all_day: true, start_at: at(780), end_at: at(840) });
    expect(clampGroupDelta(members, [...members, allDayBelow], day, 120)).toBe(120); // ignored
  });
});

describe('containerAt — attach-on-drop target', () => {
  const plan = mk({ id: 1, block_kind: 'timeblock', start_at: at(540), end_at: at(720) }); // 09:00–12:00
  const loose = mk({ id: 2, start_at: at(600), end_at: at(630) });
  const blocks = [plan, loose];

  it('returns the Plan whose window contains the dropped start', () => {
    expect(containerAt(blocks, ms(at(630)))?.id).toBe(1); // 10:30 is inside 09:00–12:00
  });
  it('returns undefined when the start falls outside every Plan window', () => {
    expect(containerAt(blocks, ms(at(800)))).toBeUndefined(); // 13:20, past the window
    expect(containerAt(blocks, ms(at(720)))).toBeUndefined(); // exactly the end is exclusive
  });
  it('ignores the block being dropped and non-container blocks', () => {
    expect(containerAt(blocks, ms(at(610)), 1)).toBeUndefined(); // excluding the only Plan
    expect(containerAt([loose], ms(at(610)))).toBeUndefined();   // no containers at all
  });
});
