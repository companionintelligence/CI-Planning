/**
 * Client-side recurrence helpers for the task editor. Translates between the UI
 * preset (None / Daily / Weekly+weekdays / Custom) and an RFC-5545 RRULE string,
 * and renders a plain-language summary. The server (engine/recurrence.ts) is the
 * source of truth for validation; this is light, dependency-free convenience.
 */
export type RepeatPreset = 'none' | 'daily' | 'weekly' | 'custom';

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export const DAY_LABEL: Record<string, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
};
/** Single-letter labels for the weekday toggle row (Mon→Sun). */
export const DAY_INITIAL: Record<string, string> = {
  MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S',
};

/** Build an RRULE from the editor state, or null for one-off / empty-custom. */
export function buildRule(preset: RepeatPreset, weekdays: string[], custom: string): string | null {
  if (preset === 'none') return null;
  if (preset === 'daily') return 'FREQ=DAILY';
  if (preset === 'weekly') {
    const days = WEEKDAYS.filter((d) => weekdays.includes(d));
    return days.length ? `FREQ=WEEKLY;BYDAY=${days.join(',')}` : 'FREQ=WEEKLY';
  }
  return custom.trim() || null; // custom
}

/** Parse an existing rule back into editor state (best-effort; falls back to custom). */
export function rulePreset(rule?: string | null): { preset: RepeatPreset; weekdays: string[]; custom: string } {
  if (!rule) return { preset: 'none', weekdays: [], custom: '' };
  const up = rule.toUpperCase();
  const freq = /FREQ=([A-Z]+)/.exec(up)?.[1];
  const byday = /BYDAY=([A-Z,]+)/.exec(up)?.[1]?.split(',') ?? [];
  if (freq === 'DAILY' && !/(COUNT|UNTIL|INTERVAL|BYDAY)/.test(up)) return { preset: 'daily', weekdays: [], custom: rule };
  if (freq === 'WEEKLY' && !/(COUNT|UNTIL|INTERVAL)/.test(up)) return { preset: 'weekly', weekdays: byday, custom: rule };
  return { preset: 'custom', weekdays: byday, custom: rule };
}

/** Plain-language summary of a rule (FREQ + BYDAY; echoes anything richer). */
export function describeRule(rule: string): string {
  const up = rule.toUpperCase();
  const freq = /FREQ=([A-Z]+)/.exec(up)?.[1];
  const byday = /BYDAY=([A-Z,]+)/.exec(up)?.[1]?.split(',') ?? [];
  if (freq === 'DAILY') return 'Repeats every day';
  if (freq === 'WEEKLY') {
    if (!byday.length) return 'Repeats weekly';
    // Weekday-only Mon–Fri is a common shorthand.
    if (byday.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => byday.includes(d))) {
      return 'Repeats every weekday';
    }
    return `Repeats every ${byday.map((d) => DAY_LABEL[d] ?? d).join(', ')}`;
  }
  if (freq === 'MONTHLY') return 'Repeats monthly';
  if (freq === 'YEARLY') return 'Repeats yearly';
  return `Repeats: ${rule}`;
}
