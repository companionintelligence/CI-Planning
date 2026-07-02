import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { serverTimezone, localDateInTZ } from '../lib/tz.js';
import { computeStars } from '../engine/stars.js';

export interface FreezeResult {
  date: string;
  total: number;
  /** True when this call froze the day's stars; false on a first-freeze-wins no-op. */
  created: boolean;
}

/**
 * Phase O · O2 — nightly star freeze.
 *
 * For the day that just ended (yesterday in the OWNER's local tz), compute the
 * five stars live and snapshot them into daily_recap. The frozen day is derived
 * from the owner timezone (not the server clock) so it matches the day boundary
 * computeStars uses (utcDayBounds(date, tz)); on a UTC server with a US/Pacific
 * owner the 00:20 cron would otherwise freeze a day ~7h before it ends.
 *
 * First-freeze-wins is keyed on `frozen_at IS NOT NULL`, NOT on row existence:
 * since daily_recap merges the star group with the summary cache (0096), a
 * summarizeDay upsert may have created the (owner, date) row first with
 * frozen_at still NULL — an existence check would then wrongly skip freezing.
 * The write is a partial upsert of only the star columns, guarded by
 * `WHERE daily_recap.frozen_at IS NULL`, so a frozen day never recomputes (even
 * against a manual same-day POST /api/jobs/:id/run after an edit) and the star
 * write never clobbers the summary group.
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

  // First-freeze-wins: never overwrite an already-FROZEN day. Keyed on
  // frozen_at (not row existence) — a summarizeDay upsert may already have
  // created this (owner, date) row with frozen_at NULL.
  const existing = sqlite
    .prepare('SELECT total, frozen_at FROM daily_recap WHERE owner_id = ? AND date = ?')
    .get(owner, date) as { total: number | null; frozen_at: string | null } | undefined;
  if (existing?.frozen_at != null) return { date, total: existing.total ?? 0, created: false };

  const stars = computeStars(owner, date);
  const frozenAt = nowISO ?? new Date().toISOString();

  // Partial upsert of ONLY the star columns, guarded so it fills stars at most
  // once — preserving immutability and never touching the summary group.
  sqlite
    .prepare(
      `INSERT INTO daily_recap
         (owner_id, date, star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, date) DO UPDATE SET
         star_objective = excluded.star_objective, star_habits = excluded.star_habits,
         star_tasks = excluded.star_tasks, star_bonus = excluded.star_bonus,
         star_note = excluded.star_note, total = excluded.total,
         frozen_at = excluded.frozen_at, updated_at = CURRENT_TIMESTAMP
       WHERE daily_recap.frozen_at IS NULL`,
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
