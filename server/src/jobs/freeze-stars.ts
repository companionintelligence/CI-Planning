import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { serverTimezone } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';
import { computeStars } from '../engine/stars.js';

export interface FreezeResult {
  date: string;
  total: number;
}

/**
 * Phase O · O2 — nightly star freeze.
 *
 * For the day that just ended (yesterday in the owner's local tz), compute the
 * five stars live and snapshot them into day_stars. Idempotent
 * (ON CONFLICT DO UPDATE) so a re-run overwrites with the same value; once the
 * day is frozen, GET /api/stars serves this row instead of recomputing, so a
 * later edit to a past task/note can't change the score.
 *
 * `forDate`/`today` are injectable for deterministic tests (no Date.now bomb).
 */
export function freezeStars(forDate?: string, today?: string): FreezeResult {
  const owner = currentOwnerId();

  const tzRow = sqlite
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get(owner) as { timezone: string | null } | undefined;
  const tz = tzRow?.timezone || serverTimezone();

  const todayStr = today ?? localISODate();
  const date = forDate ?? (() => {
    // yesterday in local time (noon-UTC pivot keeps DST arithmetic safe)
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const stars = computeStars(owner, date);
  const frozenAt = new Date().toISOString();

  sqlite
    .prepare(
      `INSERT INTO day_stars
         (owner_id, date, star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, date) DO UPDATE SET
         star_objective = excluded.star_objective,
         star_habits    = excluded.star_habits,
         star_tasks     = excluded.star_tasks,
         star_bonus     = excluded.star_bonus,
         star_note      = excluded.star_note,
         total          = excluded.total,
         frozen_at      = excluded.frozen_at`,
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

  return { date, total: stars.total };
}
