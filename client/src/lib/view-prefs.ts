/**
 * Pure (de)serialization between the in-memory calendar overlay/collapse state and
 * the persisted `view_prefs.calendar` JSON blob (server migration 0111). Kept out of
 * stores/index.ts so it's unit-testable without the SSE/resource machinery, and so
 * both hydrate (read) and persist (write) share one shape definition.
 *
 * Wire shape uses SORTED arrays (stable, diff-friendly, JSON-serializable); the store
 * uses Sets. Everything is forgiving: a missing/malformed blob yields the defaults
 * (all-on filter), so hydration can never crash on bad data.
 */
import type { ViewPrefs } from './api.js';
import { emptyAxisDeselected, TAG_AXES } from './overlay.js';
import type { AxisDeselected } from './overlay.js';
import { DEFAULT_AXIS_STATE } from './day-axis.js';
import type { AxisState } from './day-axis.js';

/** Per-axis deselected Sets → sorted arrays (only non-empty axes emitted). */
export function serializeDeselected(axes: AxisDeselected): { direction?: string[]; intention?: string[]; category?: string[] } {
  const out: { direction?: string[]; intention?: string[]; category?: string[] } = {};
  for (const axis of TAG_AXES) {
    const names = [...axes[axis]].sort();
    if (names.length) out[axis] = names;
  }
  return out;
}

/** Persisted deselected arrays → per-axis Sets. Missing/bad axis → empty (all-on). */
export function deserializeDeselected(saved: ViewPrefs['calendar'] | undefined): AxisDeselected {
  const base = emptyAxisDeselected();
  const src = saved?.deselected;
  if (!src) return base;
  for (const axis of TAG_AXES) {
    const names = src[axis];
    if (Array.isArray(names)) base[axis] = new Set(names.filter((n): n is string => typeof n === 'string'));
  }
  return base;
}

/** Persisted priority list → number[]; drops non-numbers. Missing → [] (all). */
export function deserializePrio(saved: ViewPrefs['calendar'] | undefined): number[] {
  const prio = saved?.prio;
  if (!Array.isArray(prio)) return [];
  return prio.filter((n): n is number => typeof n === 'number');
}

/**
 * Persisted collapse flags → AxisState; missing/non-boolean falls back to defaults.
 * Accepts either the `calendar` or `planner` blob — both carry the same two flags.
 */
export function deserializeAxisState(
  saved: { topExpanded?: boolean; bottomExpanded?: boolean; topEndMin?: number; bottomStartMin?: number } | undefined,
): AxisState {
  const state: AxisState = {
    topExpanded: typeof saved?.topExpanded === 'boolean' ? saved.topExpanded : DEFAULT_AXIS_STATE.topExpanded,
    bottomExpanded: typeof saved?.bottomExpanded === 'boolean' ? saved.bottomExpanded : DEFAULT_AXIS_STATE.bottomExpanded,
  };
  // Optional configurable collapse boundaries (only the planner blob writes these; the
  // calendar blob never carries them). Non-numbers are dropped — day-axis clamps range.
  if (typeof saved?.topEndMin === 'number' && Number.isFinite(saved.topEndMin)) state.topEndMin = saved.topEndMin;
  if (typeof saved?.bottomStartMin === 'number' && Number.isFinite(saved.bottomStartMin)) state.bottomStartMin = saved.bottomStartMin;
  return state;
}

/** Build the `view_prefs.planner` blob (collapse flags + configurable boundaries). */
export function buildPlannerViewPrefs(axisState: AxisState): NonNullable<ViewPrefs['planner']> {
  const out: NonNullable<ViewPrefs['planner']> = {
    topExpanded: axisState.topExpanded,
    bottomExpanded: axisState.bottomExpanded,
  };
  if (typeof axisState.topEndMin === 'number') out.topEndMin = axisState.topEndMin;
  if (typeof axisState.bottomStartMin === 'number') out.bottomStartMin = axisState.bottomStartMin;
  return out;
}

/** Build the full `view_prefs.calendar` blob from current live state. */
export function buildCalendarViewPrefs(
  axes: AxisDeselected,
  prio: number[],
  axisState: AxisState,
  eventsOnly = false,
): NonNullable<ViewPrefs['calendar']> {
  return {
    deselected: serializeDeselected(axes),
    prio: [...prio].sort((a, b) => a - b),
    topExpanded: axisState.topExpanded,
    bottomExpanded: axisState.bottomExpanded,
    eventsOnly,
  };
}

/** Persisted events-only flag → boolean. Missing/non-boolean → false (show everything). */
export function deserializeEventsOnly(saved: ViewPrefs['calendar'] | undefined): boolean {
  return saved?.eventsOnly === true;
}
