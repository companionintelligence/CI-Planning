import { describe, it, expect } from 'vitest';
import {
  occurrencesBetween,
  instanceStartUTC,
  parseRule,
  type Template,
} from '../src/engine/recurrence.js';
import { zonedWallTimeToUTC } from '../src/lib/tz.js';

/**
 * Deterministic, fixed-reference recurrence tests. The expander reads no clock of
 * its own — every window bound is passed in — so these dates are stable forever.
 *
 * The DST case is the load-bearing one: rrule.js owns the *pattern*, lib/tz.ts
 * owns the *instant*, and a spring-forward week must still yield local Mon/Wed/Fri
 * with correct UTC instants (no 23/25-hour drift).
 */

const LA = 'America/Los_Angeles';

function template(over: Partial<Template>): Template {
  return {
    recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    recurrenceDtstart: '2026-01-05T17:00:00.000Z', // Mon 2026-01-05, 09:00 PST anchor
    taskTime: '09:00',
    recurrenceExdates: [],
    timezone: LA,
    ...over,
  };
}

describe('occurrencesBetween — weekly MWF', () => {
  it('expands to exactly the right local dates over a fixed 4-week window, in order, no dupes', () => {
    // Window: Mon 2026-01-05 .. Sun 2026-02-01 (4 ISO weeks).
    const days = occurrencesBetween(template({}), '2026-01-05', '2026-02-01');
    expect(days).toEqual([
      '2026-01-05', '2026-01-07', '2026-01-09', // wk1 Mo/We/Fr
      '2026-01-12', '2026-01-14', '2026-01-16', // wk2
      '2026-01-19', '2026-01-21', '2026-01-23', // wk3
      '2026-01-26', '2026-01-28', '2026-01-30', // wk4
    ]);
    // No dupes, strictly increasing.
    expect(new Set(days).size).toBe(days.length);
    expect([...days].sort()).toEqual(days);
  });

  it('clamps to the window edges (inclusive bounds)', () => {
    // Start mid-week on a Wednesday; end on a Friday.
    const days = occurrencesBetween(template({}), '2026-01-07', '2026-01-16');
    expect(days).toEqual(['2026-01-07', '2026-01-09', '2026-01-12', '2026-01-14', '2026-01-16']);
  });
});

describe('occurrencesBetween — DST spring-forward week', () => {
  // US spring-forward 2026 is Sunday 2026-03-08 (clocks jump 02:00 → 03:00 PST→PDT).
  it('still yields local Mon/Wed/Fri across the transition week', () => {
    const days = occurrencesBetween(template({}), '2026-03-02', '2026-03-15');
    expect(days).toEqual([
      '2026-03-02', '2026-03-04', '2026-03-06', // week containing... pre-DST
      '2026-03-09', '2026-03-11', '2026-03-13', // week of/after the Sun 03-08 flip
    ]);
  });

  it('resolves each instance start to the correct UTC instant with no 23/25h drift', () => {
    const tz = LA;
    // Friday before DST: 09:00 PST = 17:00 UTC.
    expect(instanceStartUTC('2026-03-06', '09:00', tz)).toBe('2026-03-06T17:00:00.000Z');
    // Monday after DST: 09:00 PDT = 16:00 UTC. The wall-clock label is identical
    // (09:00) but the UTC instant moved by exactly one hour — the DST contract.
    expect(instanceStartUTC('2026-03-09', '09:00', tz)).toBe('2026-03-09T16:00:00.000Z');
    // Sanity: these two consecutive scheduled days are NOT 48h apart in UTC
    // (Fri 17:00Z → Mon 16:00Z = 71h, i.e. 72h minus the lost DST hour).
    const fri = Date.parse('2026-03-06T17:00:00.000Z');
    const mon = Date.parse('2026-03-09T16:00:00.000Z');
    expect((mon - fri) / 3_600_000).toBe(71);
  });

  it('instanceStartUTC agrees with zonedWallTimeToUTC (single source of truth)', () => {
    for (const day of ['2026-03-06', '2026-03-09', '2026-03-11']) {
      expect(instanceStartUTC(day, '09:00', LA)).toBe(zonedWallTimeToUTC(day, '09:00', LA));
    }
  });

  it('defaults to local midnight when taskTime is null', () => {
    expect(instanceStartUTC('2026-03-09', null, LA)).toBe(zonedWallTimeToUTC('2026-03-09', '00:00', LA));
  });
});

describe('occurrencesBetween — COUNT / UNTIL', () => {
  it('honors COUNT (series stops after N occurrences)', () => {
    const t = template({ recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4' });
    const days = occurrencesBetween(t, '2026-01-05', '2026-02-28');
    expect(days).toEqual(['2026-01-05', '2026-01-07', '2026-01-09', '2026-01-12']);
  });

  it('honors UNTIL (no occurrences past the bound)', () => {
    // UNTIL is an instant; stop at/after Fri 2026-01-16.
    const t = template({ recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260116T235959Z' });
    const days = occurrencesBetween(t, '2026-01-05', '2026-02-28');
    expect(days).toEqual([
      '2026-01-05', '2026-01-07', '2026-01-09',
      '2026-01-12', '2026-01-14', '2026-01-16',
    ]);
  });
});

describe('occurrencesBetween — EXDATE', () => {
  it('removes exactly the excluded local day, nothing else', () => {
    const t = template({ recurrenceExdates: ['2026-01-14'] });
    const days = occurrencesBetween(t, '2026-01-12', '2026-01-16');
    expect(days).toEqual(['2026-01-12', '2026-01-16']); // 01-14 (Wed) excised
  });

  it('an EXDATE outside the window is a no-op', () => {
    const t = template({ recurrenceExdates: ['2025-12-31'] });
    const days = occurrencesBetween(t, '2026-01-05', '2026-01-09');
    expect(days).toEqual(['2026-01-05', '2026-01-07', '2026-01-09']);
  });
});

describe('parseRule — validation', () => {
  it('accepts a valid weekly MWF rule and round-trips it', () => {
    const r = parseRule('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule).toMatch(/FREQ=WEEKLY/);
      expect(r.rule).toMatch(/BYDAY=MO,WE,FR/);
    }
  });

  it('accepts a daily rule', () => {
    expect(parseRule('FREQ=DAILY').ok).toBe(true);
  });

  it('strips a leading RRULE: prefix', () => {
    expect(parseRule('RRULE:FREQ=DAILY').ok).toBe(true);
  });

  it('rejects a rule with no FREQ', () => {
    const r = parseRule('BYDAY=MO,WE,FR');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/FREQ/i);
  });

  it('rejects FREQ=HOURLY (sub-daily)', () => {
    const r = parseRule('FREQ=HOURLY');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sub-daily|HOURLY/i);
  });

  it('rejects FREQ=MINUTELY and FREQ=SECONDLY', () => {
    expect(parseRule('FREQ=MINUTELY').ok).toBe(false);
    expect(parseRule('FREQ=SECONDLY').ok).toBe(false);
  });

  it('rejects an empty / whitespace rule', () => {
    expect(parseRule('').ok).toBe(false);
    expect(parseRule('   ').ok).toBe(false);
  });

  it('rejects garbage without throwing', () => {
    const r = parseRule('not a rule at all');
    expect(r.ok).toBe(false);
  });

  it('rejects a COUNT beyond the horizon ceiling', () => {
    const r = parseRule('FREQ=DAILY;COUNT=100000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/COUNT|ceiling/i);
  });

  it('rejects an UNTIL beyond the horizon ceiling', () => {
    const r = parseRule('FREQ=DAILY;UNTIL=21000101T000000Z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/UNTIL|ceiling/i);
  });
});
