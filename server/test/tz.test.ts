import { describe, it, expect } from 'vitest';
import { zonedWallTimeToUTC, utcDayBounds, serverTimezone } from '../src/lib/tz.js';

describe('tz helpers', () => {
  it('maps a wall-clock time to UTC for zones west of UTC (PDT)', () => {
    // June → PDT (UTC-7): 09:00 local is 16:00 UTC.
    expect(zonedWallTimeToUTC('2026-06-15', '09:00', 'America/Los_Angeles')).toBe('2026-06-15T16:00:00.000Z');
  });

  it('maps a wall-clock time to UTC for zones east of UTC (JST)', () => {
    // Tokyo (UTC+9, no DST): 09:00 local is 00:00 UTC.
    expect(zonedWallTimeToUTC('2026-06-15', '09:00', 'Asia/Tokyo')).toBe('2026-06-15T00:00:00.000Z');
  });

  it('is identity for UTC', () => {
    expect(zonedWallTimeToUTC('2026-06-15', '09:00', 'UTC')).toBe('2026-06-15T09:00:00.000Z');
  });

  it('respects DST: the same wall time shifts by an hour across the transition', () => {
    // January → PST (UTC-8): 09:00 local is 17:00 UTC (vs 16:00 in summer).
    expect(zonedWallTimeToUTC('2026-01-15', '09:00', 'America/Los_Angeles')).toBe('2026-01-15T17:00:00.000Z');
  });

  it('computes local-day bounds as UTC instants', () => {
    const { start, end } = utcDayBounds('2026-06-15', 'America/Los_Angeles');
    expect(start).toBe('2026-06-15T07:00:00.000Z'); // local midnight PDT
    expect(end).toBe('2026-06-16T07:00:00.000Z'); // next local midnight
  });

  it('reports a usable server timezone', () => {
    expect(typeof serverTimezone()).toBe('string');
    expect(serverTimezone().length).toBeGreaterThan(0);
  });
});
