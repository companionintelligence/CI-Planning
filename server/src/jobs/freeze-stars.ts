import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { serverTimezone, localDateInTZ } from '../lib/tz.js';
import { computeStars } from '../engine/stars.js';

export interface FreezeResult {
  date: string;
  total: number;
  /** True when this call inserted the day_stars row; false on a first-freeze-wins no-op. */
  created: boolean;
}

/**
 * Phase O · O2 — nightly star freeze.
 *
 * For the day that just ended (yesterday in the OWNER's local tz), compute the
 * five stars live and snapshot them into day_stars. The frozen day is derived
 * from the owner timezone (not the server clock) so it matches the day boundary
 * computeStars uses (utcDayBounds(date, tz)); on a UTC server with a US/Pacific
 * owner the 00:20 cron would otherwise freeze a day ~7h before it ends.
 *
 * First-freeze-wins: if a day_stars row already exists for (owner, date), this
 * is a no-op that returns the existing total. That makes the frozen score
 * immutable even against a manual same-day POST /api/jobs/:id/run after an edit.
 *
 * `forDate`/`nowISO` are injectable for deterministic tests (no Date.now bomb).
 */
export function freezeStars(forDate?: string, nowISO?: string): FreezeResult {
  const owner = currentOwnerId();

  const tzRow = sqlite
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get(owner) as { timezone: string | null } | undefined;
  const tz = tzRow?.timezone || serverTimezone();

  // The owner-tz "today" of the given instant, then yesterday from it.
  const todayStr = localDateInTZ(nowISO ?? new Date().toISOString(), tz);
  const date = forDate ?? (() => {
    // yesterday in local time (noon-UTC pivot keeps DST arithmetic safe)
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  // First-freeze-wins: never overwrite an already-frozen day.
  const existing = sqlite
    .prepare('SELECT total FROM day_stars WHERE owner_id = ? AND date = ?')
    .get(owner, date) as { total: number } | undefined;
  if (existing) return { date, total: existing.total, created: false };

  const stars = computeStars(owner, date);
  const frozenAt = nowISO ?? new Date().toISOString();

  sqlite
    .prepare(
      `INSERT INTO day_stars
         (owner_id, date, star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      owner,
      date,
      stars.objective ? 1 : 0,
      stars.habits ? 1 : 0,
      stars.tasks ? 1 : 0,
      stars.bonus ? 1 : 0,
      stars.note ? 1 : 0,
      stars.total,
      frozenAt,
    );

  return { date, total: stars.total, created: true };
}
