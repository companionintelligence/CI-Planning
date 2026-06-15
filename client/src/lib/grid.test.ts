import { describe, it, expect } from 'vitest';
import {
  PX_PER_MIN,
  SNAP_MIN,
  minutesIntoDay,
  instantFor,
  yOf,
  minsOf,
} from './grid.js';
import { rangeUTC, weekDaysOf, monthGridOf, addDays } from './dates.js';

// These tests assume TZ=America/Los_Angeles (set in vitest.config.ts) so the
// local-midnight math is deterministic and the spring-forward case is exercised.

describe('grid math — no tz drift', () => {
  it('minutesIntoDay ∘ instantFor is the identity for sampled instants', () => {
    const day = '2026-06-15'; // PDT, a normal day
    for (const mins of [0, 15, 90, 540, 543, 720, 1439, 1440 - SNAP_MIN]) {
      const iso = instantFor(day, mins);
      expect(minutesIntoDay(iso, day)).toBeCloseTo(mins, 9);
    }
  });

  it('instantFor ∘ minutesIntoDay round-trips a stored UTC instant byte-identically', () => {
    const day = '2026-06-15';
    // 09:00 local PDT == 16:00 UTC.
    const stored = '2026-06-15T16:00:00.000Z';
    const mins = minutesIntoDay(stored, day);
    expect(instantFor(day, mins)).toBe(stored);
  });

  it('a 0-distance move (mins unchanged) produces a byte-identical instant', () => {
    const day = '2026-06-15';
    const stored = '2026-06-15T16:30:00.000Z';
    const mins = minutesIntoDay(stored, day);
    expect(instantFor(day, mins)).toBe(stored); // the PR-3 "0px drag is a no-op write" property
  });
});

describe('grid math — pixel positioning', () => {
  it('a 30-min block at 09:00 local maps to the expected top/height', () => {
    const day = '2026-06-15';
    const start = instantFor(day, 9 * 60);      // 09:00 local
    const end = instantFor(day, 9 * 60 + 30);   // 09:30 local
    const topMin = minutesIntoDay(start, day);
    const heightMin = minutesIntoDay(end, day) - topMin;
    expect(topMin).toBe(540);
    expect(heightMin).toBe(30);
    expect(yOf(topMin)).toBeCloseTo(540 * PX_PER_MIN, 9); // 432px at 0.8px/min
    expect(yOf(heightMin)).toBeCloseTo(30 * PX_PER_MIN, 9); // 24px
  });

  it('minsOf snaps pixels back to SNAP_MIN granularity', () => {
    expect(minsOf(yOf(540))).toBe(540);          // exact
    expect(minsOf(yOf(547))).toBe(540);          // 547 → nearest 15 = 540
    expect(minsOf(yOf(548))).toBe(555);          // 548 → nearest 15 = 555
    expect(minsOf(yOf(0))).toBe(0);
  });
});

describe('grid math — DST (spring-forward)', () => {
  // 2026-03-08 in America/Los_Angeles: clocks jump 02:00 PST → 03:00 PDT.
  // A block from 01:00 local to 04:00 local spans the gap: 4 wall-clock hours but
  // only 3 real elapsed hours. The grid must use REAL elapsed minutes.
  const springDay = '2026-03-08';

  it('uses real elapsed minutes across the spring-forward gap (no off-by-60)', () => {
    // 01:00 PST == 09:00 UTC; 04:00 PDT == 11:00 UTC → 2 real hours = 120 min.
    const start = '2026-03-08T09:00:00.000Z';
    const end = '2026-03-08T11:00:00.000Z';
    const topMin = minutesIntoDay(start, springDay);
    const elapsed = minutesIntoDay(end, springDay) - topMin;
    expect(topMin).toBe(60);       // 01:00 local = 60 min after local midnight
    expect(elapsed).toBe(120);     // 2 real hours, NOT 180 (would be wall-clock drift)
  });

  it('positions a block on the DST day by elapsed ms, not wall-clock slicing', () => {
    // 10:00 local PDT on the spring day == 17:00 UTC. Local midnight is 08:00 UTC
    // (PST, before the gap). Real elapsed from midnight to 17:00 UTC is 9h = 540
    // min — NOT the 10h=600 a wall-clock reading would give, because the
    // 02:00–03:00 hour was skipped. Using elapsed ms is exactly what avoids drift.
    const stored = '2026-03-08T17:00:00.000Z';
    expect(minutesIntoDay(stored, springDay)).toBe(540);
    // Naive wall-clock slicing of "17:00Z" would wrongly yield 1020 — guard against that.
    expect(minutesIntoDay(stored, springDay)).not.toBe(Number('17') * 60);
    // and the inverse rebuilds the same instant (round-trip, no drift).
    expect(instantFor(springDay, 540)).toBe(stored);
  });
});

describe('date range helpers', () => {
  it('rangeUTC bounds a multi-day local window with local-midnight edges', () => {
    const { from, to } = rangeUTC('2026-06-15', '2026-06-21');
    // PDT (UTC-7): local midnight 06-15 == 07:00Z; end-of-day 06-21 == 06-22 06:59:59.999Z.
    expect(from).toBe('2026-06-15T07:00:00.000Z');
    expect(to).toBe('2026-06-22T06:59:59.999Z');
  });

  it('weekDaysOf returns Mon..Sun for the week containing the anchor', () => {
    // 2026-06-15 is a Monday.
    expect(weekDaysOf('2026-06-15')).toEqual([
      '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18',
      '2026-06-19', '2026-06-20', '2026-06-21',
    ]);
    // A Sunday anchor still belongs to the week that started the prior Monday.
    expect(weekDaysOf('2026-06-21')[0]).toBe('2026-06-15');
  });

  it('monthGridOf returns 42 Monday-aligned days covering the month', () => {
    const grid = monthGridOf('2026-06-15');
    expect(grid.length).toBe(42);
    // June 2026 starts on a Monday, so the grid starts exactly on June 1.
    expect(grid[0]).toBe('2026-06-01');
    expect(grid[41]).toBe(addDays('2026-06-01', 41));
    // First cell is always a Monday.
    expect(new Date(grid[0] + 'T12:00:00Z').getUTCDay()).toBe(1);
  });

  it('monthGridOf includes leading days from the previous month when needed', () => {
    // July 2026 starts on a Wednesday → grid backs up to Mon Jun 29.
    const grid = monthGridOf('2026-07-15');
    expect(grid[0]).toBe('2026-06-29');
    expect(grid.length).toBe(42);
    expect(new Date(grid[0] + 'T12:00:00Z').getUTCDay()).toBe(1);
  });
});
