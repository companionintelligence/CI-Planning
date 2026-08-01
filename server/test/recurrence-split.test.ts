import { describe, it, expect } from 'vitest';
import { boundRuleBefore, occurrencesBetween, type Template } from '../src/engine/recurrence.js';

/**
 * "This and all following" is implemented as a SERIES SPLIT: the original rule is bounded
 * to stop before the clicked occurrence, and a new template carries the change forward.
 * These pin the half that is easy to get subtly wrong — the boundary — including across
 * a timezone where local midnight is not UTC midnight.
 */

const TZ = 'America/Los_Angeles';
const DTSTART = '2026-08-07T16:00:00.000Z'; // Fri 2026-08-07, 09:00 local

function tpl(rule: string, exdates: string[] = []): Template {
  return { recurrenceRule: rule, recurrenceDtstart: DTSTART, taskTime: '09:00', recurrenceExdates: exdates, timezone: TZ };
}

describe('boundRuleBefore', () => {
  it('stops the series the day BEFORE the split — the split day belongs to the new half', () => {
    // Series: Aug 7, 14, 21, 28. Split at Aug 21 ⇒ the old half keeps 7 and 14 only.
    const r = boundRuleBefore('FREQ=WEEKLY;BYDAY=FR', '2026-08-21', TZ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const before = occurrencesBetween(tpl(r.rule), '2026-08-01', '2026-09-30');
    expect(before).toEqual(['2026-08-07', '2026-08-14']);
    expect(before).not.toContain('2026-08-21');
  });

  it('drops COUNT — RFC 5545 allows only one of COUNT/UNTIL', () => {
    const r = boundRuleBefore('FREQ=DAILY;COUNT=10', '2026-08-21', TZ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule).not.toMatch(/COUNT=/i);
    expect(r.rule).toMatch(/UNTIL=/i);
  });

  it('replaces an existing UNTIL rather than emitting two', () => {
    const r = boundRuleBefore('FREQ=DAILY;UNTIL=20261231T235959Z', '2026-08-21', TZ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule.match(/UNTIL=/gi)).toHaveLength(1);
  });

  it('uses the OWNER timezone for the boundary, not the server clock', () => {
    // Local midnight in Los Angeles is 07:00Z (PDT). A UTC-midnight boundary would
    // wrongly keep the split day in the old half for anyone west of Greenwich.
    const r = boundRuleBefore('FREQ=DAILY', '2026-08-20', TZ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const days = occurrencesBetween(tpl(r.rule), '2026-08-07', '2026-08-31');
    expect(days).toContain('2026-08-19');
    expect(days).not.toContain('2026-08-20'); // the split day is excluded
  });

  it('splitting on the FIRST occurrence leaves an empty old half', () => {
    const r = boundRuleBefore('FREQ=WEEKLY;BYDAY=FR', '2026-08-07', TZ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(occurrencesBetween(tpl(r.rule), '2026-08-01', '2026-09-30')).toEqual([]);
  });

  it('rejects a malformed split date instead of silently unbounding the series', () => {
    expect(boundRuleBefore('FREQ=DAILY', 'not-a-date', TZ).ok).toBe(false);
  });
});
