/**
 * Phase Z · Z3b — the Focus Ritual's *appearance* prefs, as pure functions.
 *
 * Everything here is display-only. The style, the tint and the session length are
 * owner preferences stored in the `view_prefs.focus` JSON blob (no migration — the
 * column takes any plain object); **none of them is ever written back onto a task
 * or a block.** Picking a colour in the Focus Lab changes what the ritual is lit
 * with and records the choice, and that is all it does.
 *
 * Kept out of stores/index.ts so the defaults and the resolution order are
 * unit-testable without the resource machinery, and so the FOCUS view, Settings
 * and the ritual itself all read one definition rather than three.
 */
import type { ViewPrefs } from './api.js';
import { colorVar, directionColorForTask } from './pattern-meta.js';
import { blockColorVar } from './textures.js';

/** The two ritual surfaces (FocusSurface.tsx renders them). Breath is the default. */
export type FocusStyle = 'breath' | 'signal';

export const FOCUS_STYLES: { id: FocusStyle; name: string; hint: string }[] = [
  { id: 'breath', name: 'Breath', hint: 'A 5.5-breaths/min pacer inside a ring that closes with the block.' },
  { id: 'signal', name: 'Signal', hint: 'Ambient light from below, with one hairline of progress.' },
];

export const DEFAULT_FOCUS_STYLE: FocusStyle = 'breath';

/** "Start now" lengths the Focus Lab offers. `null` = follow the task's estimate. */
export const SESSION_MINUTES = [15, 25, 50, 90] as const;

/** The shortest block "Start now" will ever anchor — the pre-existing floor in FOCUS. */
export const MIN_SESSION_MIN = 15;
/** Length used when a task carries no estimate and no fixed session is chosen. */
export const FALLBACK_SESSION_MIN = 30;

export interface FocusAppearance {
  style: FocusStyle;
  /** Token key ('tag-6', 'chart-1', …) or null to follow the task's direction colour. */
  colorToken: string | null;
  /** Fixed session length in minutes, or null to follow the task's estimate. */
  sessionMinutes: number | null;
}

export const FOCUS_APPEARANCE_DEFAULTS: FocusAppearance = {
  style: DEFAULT_FOCUS_STYLE,
  colorToken: null,
  sessionMinutes: null,
};

const isStyle = (v: unknown): v is FocusStyle => v === 'breath' || v === 'signal';

/**
 * `view_prefs.focus` → a complete FocusAppearance. Forgiving in both directions: a
 * missing blob, a stale style id from an earlier build, or a junk session length all
 * fall back to the defaults rather than rendering a broken ritual.
 */
export function readFocusAppearance(vp: ViewPrefs | null | undefined): FocusAppearance {
  const f = vp?.focus;
  const minutes = f?.sessionMinutes;
  return {
    style: isStyle(f?.style) ? f!.style! : DEFAULT_FOCUS_STYLE,
    colorToken: typeof f?.colorToken === 'string' && f.colorToken ? f.colorToken : null,
    sessionMinutes:
      typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null,
  };
}

/**
 * Merge a partial change into the whole `view_prefs` blob, ready for
 * `api.prefs.update`. Merge-over-existing so the calendar/planner/appearance blobs
 * survive a focus-only write. `null` is meaningful (it clears an override), so only
 * `undefined` keys are skipped.
 */
export function writeFocusAppearance(
  existing: ViewPrefs | null | undefined,
  patch: Partial<FocusAppearance>,
): ViewPrefs {
  const base = existing ?? {};
  const focus = { ...(base.focus ?? {}) };
  if (patch.style !== undefined) focus.style = patch.style;
  if (patch.colorToken !== undefined) focus.colorToken = patch.colorToken;
  if (patch.sessionMinutes !== undefined) focus.sessionMinutes = patch.sessionMinutes;
  return { ...base, focus };
}

/**
 * How long a "Start now" block should run: the owner's fixed session length if they
 * chose one, else the task's own estimate, else the 30-minute fallback — floored at
 * 15 minutes, which is the rule FOCUS already applied before the pref existed.
 */
export function resolveSessionMinutes(
  sessionMinutes: number | null,
  estimateMinutes: number | null | undefined,
): number {
  const chosen = sessionMinutes ?? estimateMinutes ?? FALLBACK_SESSION_MIN;
  const n = Number.isFinite(chosen) && chosen! > 0 ? chosen! : FALLBACK_SESSION_MIN;
  return Math.max(MIN_SESSION_MIN, Math.round(n));
}

/** A task's direction (Work / Home / Community) tag, or null if it carries none. */
function directionOf(
  task: { tags?: string[] | null } | null | undefined,
  tagDefs: { id: string; name: string; kind: string }[],
): { id: string; name: string } | null {
  const names = task?.tags ?? [];
  return tagDefs.find((t) => t.kind === 'direction' && names.includes(t.name)) ?? null;
}

/**
 * The CSS colour the ritual is lit with, in priority order:
 *
 *   1. the owner's Focus Lab override, if they set one;
 *   2. the task's **direction** colour — Work / Home / Community — so the ritual
 *      matches the colour that task already wears everywhere else;
 *   3. the block's own category/tag colour (the pre-direction behaviour);
 *   4. `var(--primary)`.
 *
 * Always a token `var(--…)`, never a literal, so the ritual themes light/dark with
 * the rest of the app. Step 2 tests for the direction tag itself rather than reading
 * `directionColorForTask`'s return, because that helper answers `var(--primary)` for
 * "no direction" — indistinguishable from a direction genuinely coloured primary.
 */
export function resolveFocusTint(args: {
  override?: string | null;
  task?: { tags?: string[] | null } | null;
  tagDefs?: { id: string; name: string; kind: string }[];
  patternPrefs?: Record<string, { color_token?: string | null }>;
  block?: { color_token?: string | null; category_id?: string | null; tag?: string | null } | null;
  categoryPrefs?: Record<string, { color_token: string }>;
}): string {
  if (args.override) return colorVar(args.override);

  const tagDefs = args.tagDefs ?? [];
  if (args.task && directionOf(args.task, tagDefs)) {
    return directionColorForTask(args.task, tagDefs, args.patternPrefs ?? {});
  }

  if (args.block) return blockColorVar(args.block, args.categoryPrefs);
  return 'var(--primary)';
}
