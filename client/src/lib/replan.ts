import type { ReplanDiff } from './api.js';

/** Length of a value only if it's actually an array — tolerant of legacy/garbage payloads. */
const len = (x: unknown): number => (Array.isArray(x) ? x.length : 0);

/**
 * Phase M B3 — build the low-noise reflow toast message from a `schedule:done`
 * payload, or `null` when nothing actually changed (so no toast fires).
 *
 * Robustness: the `schedule:done` event has had more than one payload shape over
 * time (the reactive reflow sends a `ReplanDiff`; the legacy `runScheduler` path
 * sent a diff-less `ScheduleResult`). A payload without the diff arrays counts as
 * "no change" and returns null — never throws.
 */
export function replanToastMessage(payload: unknown): string | null {
  const d = (payload ?? {}) as Partial<ReplanDiff>;
  const moved = len(d.moved);
  const total = moved + len(d.removed) + len(d.added);
  if (total === 0) return null;
  if (moved > 0) return `Re-planned: ${moved} block${moved === 1 ? '' : 's'} moved`;
  return 'Re-planned';
}
