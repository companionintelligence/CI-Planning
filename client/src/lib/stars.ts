import type { DayStars } from './api.js';

/**
 * Phase O · O3 — client-side star presentation helpers (pure).
 *
 * The five-star day score is DERIVED and served by GET /api/stars (O2). The
 * client never recomputes it — these helpers only shape the served booleans for
 * rendering: the header's small `n/5` tally, the per-star what's-needed hint, and
 * the calendar heatmap (pips vs the perfect-day single star).
 */

/** The five star slots in fixed display order. */
export const STAR_ORDER: (keyof DayStars)[] = ['objective', 'habits', 'tasks', 'bonus', 'note'];

/** Human hint shown on tapping/hovering a star — what earns it. */
export const STAR_HINT: Record<string, string> = {
  objective: "Intention — complete today's focus",
  habits: 'Habits — finish every habit due today',
  tasks: 'Tasks — complete every task planned for today',
  bonus: 'Bonus — complete an unplanned task today',
  note: 'Reflection — finish a task and save a day note',
};

/** Gold for an earned star, muted teal-navy for an empty slot (spec colors). */
export const STAR_GOLD = '#f4d35e';
export const STAR_MUTED = '#3a5560';

export interface StarSlot {
  key: string;
  earned: boolean;
  hint: string;
  color: string;
}

/** The five ordered slots for a day's stars — earned/muted + hint + color. */
export function starSlots(stars: DayStars): StarSlot[] {
  return STAR_ORDER.map((key) => {
    const earned = !!stars[key];
    return { key, earned, hint: STAR_HINT[key], color: earned ? STAR_GOLD : STAR_MUTED };
  });
}

/** A perfect day — all five stars earned (the calendar single-star treatment). */
export function isPerfectDay(total: number): boolean {
  return total >= 5;
}

/** `n` gold pips for a non-perfect day (0..5); [] for a perfect day (uses the
 *  single-star treatment instead). Drives the calendar heatmap. */
export function pipCount(total: number): number {
  if (isPerfectDay(total)) return 0;
  return Math.max(0, Math.min(5, total));
}
