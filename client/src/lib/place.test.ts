import { describe, it, expect } from 'vitest';
import { spanAtY } from './place.js';
import { instantFor, minutesIntoDay, yOf, MINUTES_PER_DAY, SNAP_MIN } from './grid.js';

/**
 * Pure placement math (CON-5). A block created by clicking an empty slot — or by
 * dropping a flight-plan task — must snap its start to the grid and carry the right
 * duration as REAL elapsed time, with no tz drift. Same TZ pin as grid.test.ts
 * (America/Los_Angeles, set in vitest.config.ts), so the spring-forward case bites.
 */
const day = '2026-06-15';
const ms = (iso: string) => Date.parse(iso);

describe('spanAtY — Y + duration → { start_at, end_at }', () => {
  it('starts at the snapped grid time for the clicked/dropped Y', () => {
    expect(spanAtY(day, yOf(540), 60).start_at).toBe(instantFor(day, 540)); // 09:00
    expect(spanAtY(day, yOf(547), 60).start_at).toBe(instantFor(day, 540)); // snaps down
    expect(spanAtY(day, yOf(548), 60).start_at).toBe(instantFor(day, 555)); // snaps up
  });

  it('sets end_at exactly durationMin real-minutes after start', () => {
    for (const dur of [15, 30, 60, 90, 240]) {
      const s = spanAtY(day, yOf(600), dur);
      expect(ms(s.end_at) - ms(s.start_at)).toBe(dur * 60_000);
    }
  });

  it('a 60-minute default block reads as a clean top/height on the grid', () => {
    const s = spanAtY(day, yOf(540), 60);
    expect(minutesIntoDay(s.start_at, day)).toBe(540);
    expect(minutesIntoDay(s.end_at, day) - minutesIntoDay(s.start_at, day)).toBe(60);
  });

  it('clamps a non-positive duration up to one snap step (never zero-length)', () => {
    const s = spanAtY(day, yOf(540), 0);
    expect(ms(s.end_at) - ms(s.start_at)).toBe(SNAP_MIN * 60_000);
  });

  it('clamps the start into the day (below midnight, past end-of-day)', () => {
    expect(spanAtY(day, -500, 60).start_at).toBe(instantFor(day, 0));
    expect(spanAtY(day, yOf(MINUTES_PER_DAY + 600), 60).start_at).toBe(instantFor(day, MINUTES_PER_DAY - SNAP_MIN));
  });

  it('no tz drift across the spring-forward day (duration is real elapsed ms)', () => {
    const springDay = '2026-03-08'; // 02:00 PST → 03:00 PDT
    const s = spanAtY(springDay, yOf(60), 180); // start 01:00 local, 3h block over the gap
    expect(ms(s.end_at) - ms(s.start_at)).toBe(180 * 60_000); // 3 real hours, no off-by-60
  });
});
