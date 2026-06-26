import type { TrustMode } from './api.js';

/**
 * Pure model for the automation **trust dial** (FTUE gaps 5 & 6) — a Setting, not a
 * glossary noun. The component (`components/TrustDial.tsx`) renders these; the logic is
 * extracted here so it's unit-testable without a render harness (mirrors lib/replan.ts).
 */
export interface TrustOption {
  value: TrustMode;
  label: string;
  blurb: string;
}

export const DEFAULT_TRUST: TrustMode = 'balanced';

export const TRUST_OPTIONS: readonly TrustOption[] = [
  { value: 'cautious', label: 'Cautious', blurb: 'Nothing schedules itself — every item waits in the Inbox for you.' },
  { value: 'balanced', label: 'Balanced', blurb: 'High-confidence items auto-promote to Tasks; you choose when to schedule them.' },
  { value: 'hands_off', label: 'Hands-off', blurb: 'Auto-promote and auto-schedule tasks that have a time estimate — fewest clicks.' },
];

/** The hover/title summary of all three states. */
export const TRUST_TITLE =
  'Cautious: nothing auto-promotes or schedules. ' +
  'Balanced: high-confidence items become Tasks; you schedule. ' +
  'Hands-off: estimate-bearing tasks also auto-schedule as they arrive.';

/** Resolve the active dial value, defaulting safely when the pref is absent/unknown. */
export function resolveTrustValue(mode: TrustMode | undefined | null): TrustMode {
  return mode === 'cautious' || mode === 'balanced' || mode === 'hands_off' ? mode : DEFAULT_TRUST;
}

/** The one-line description for a state (empty string if unknown). */
export function blurbFor(mode: TrustMode): string {
  return TRUST_OPTIONS.find((o) => o.value === mode)?.blurb ?? '';
}
