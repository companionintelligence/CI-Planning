import { describe, it, expect } from 'vitest';
import { buildRule, rulePreset, rulePresetForPattern, describeRule } from './recurrence.js';

describe('buildRule', () => {
  it('none → null', () => expect(buildRule('none', [], '')).toBeNull());
  it('daily → FREQ=DAILY', () => expect(buildRule('daily', [], '')).toBe('FREQ=DAILY'));
  it('weekly with weekdays → BYDAY', () =>
    expect(buildRule('weekly', ['MO', 'WE', 'FR'], '')).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR'));
  it('weekly with no weekdays → plain weekly', () => expect(buildRule('weekly', [], '')).toBe('FREQ=WEEKLY'));
  it('weekly emits canonical Mon→Sun order regardless of toggle order', () =>
    expect(buildRule('weekly', ['FR', 'MO'], '')).toBe('FREQ=WEEKLY;BYDAY=MO,FR'));
  it('custom → trimmed string, or null when blank', () => {
    expect(buildRule('custom', [], '  FREQ=MONTHLY ')).toBe('FREQ=MONTHLY');
    expect(buildRule('custom', [], '   ')).toBeNull();
  });
  it('specific-days with weekdays → BYDAY (UI-label distinct from weekly, RRULE-equivalent)', () => {
    expect(buildRule('specific-days', ['MO', 'WE'], '')).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(buildRule('specific-days', [], '')).toBe('FREQ=WEEKLY');
  });
  it('monthly / yearly', () => {
    expect(buildRule('monthly', [], '')).toBe('FREQ=MONTHLY');
    expect(buildRule('yearly', [], '')).toBe('FREQ=YEARLY');
  });
});

describe('rulePreset', () => {
  it('null → none', () => expect(rulePreset(null)).toEqual({ preset: 'none', weekdays: [], custom: '' }));
  it('FREQ=DAILY → daily', () => expect(rulePreset('FREQ=DAILY').preset).toBe('daily'));
  it('FREQ=WEEKLY;BYDAY → weekly + weekdays', () => {
    const ps = rulePreset('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(ps.preset).toBe('weekly');
    expect(ps.weekdays).toEqual(['MO', 'WE', 'FR']);
  });
  it('a rule with COUNT / INTERVAL falls back to custom (round-trips the raw string)', () => {
    expect(rulePreset('FREQ=DAILY;COUNT=5').preset).toBe('custom');
    expect(rulePreset('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO').preset).toBe('custom');
  });
  it('FREQ=MONTHLY / FREQ=YEARLY → monthly / yearly', () => {
    expect(rulePreset('FREQ=MONTHLY').preset).toBe('monthly');
    expect(rulePreset('FREQ=YEARLY').preset).toBe('yearly');
  });
  it('round-trips: build(specific-days) → rulePresetForPattern reads back as specific-days', () => {
    const rule = buildRule('specific-days', ['MO', 'WE'], '')!;
    expect(rulePresetForPattern(rule)).toEqual({ preset: 'specific-days', weekdays: ['MO', 'WE'], custom: rule });
    // rulePreset (task-level) still surfaces it as weekly
    expect(rulePreset(rule).preset).toBe('weekly');
  });
});

describe('describeRule', () => {
  it('daily', () => expect(describeRule('FREQ=DAILY')).toBe('Repeats every day'));
  it('Mon–Fri shorthand', () => expect(describeRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Repeats every weekday'));
  it('specific weekdays', () => expect(describeRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toBe('Repeats every Mon, Wed, Fri'));
  it('weekly with no days', () => expect(describeRule('FREQ=WEEKLY')).toBe('Repeats weekly'));
  it('monthly / yearly', () => {
    expect(describeRule('FREQ=MONTHLY')).toBe('Repeats monthly');
    expect(describeRule('FREQ=YEARLY')).toBe('Repeats yearly');
  });
  it('round-trips build → describe for weekly MWF', () => {
    expect(describeRule(buildRule('weekly', ['MO', 'WE', 'FR'], '')!)).toBe('Repeats every Mon, Wed, Fri');
  });
});
