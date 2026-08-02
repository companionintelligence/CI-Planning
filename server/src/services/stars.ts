import { store } from '../db/store.js';
import { computeStars, type DayStars } from '../engine/stars.js';

/**
 * Owner-scoped reads for the gamified 5-star day (Phase O / daily_recap).
 *
 * Extracted from routes/stars.ts (GET /api/stars) so both REST and GraphQL call the
 * SAME owner-scoped logic (Decision 3). Pure reads — no writes; the freeze WRITE stays
 * in jobs/freeze-stars.ts and the summary WRITE in agents/summarize.ts.
 */

/** One day's five-star score, tagged with whether it came from the frozen snapshot. */
export interface DayStarsRow extends DayStars {
  date: string;
  frozen: boolean;
}

/** The mutable summary group of a daily_recap row (from agents/summarize.ts's writer). */
export interface DailyRecapRow {
  date: string;
  prose: string | null;
  stats: string | null;
  focus: string | null;
  llm: boolean | null;
  inputsHash: string | null;
  // stars group (immutable once frozen_at is set)
  objective: boolean | null;
  habits: boolean | null;
  tasks: boolean | null;
  bonus: boolean | null;
  note: boolean | null;
  total: number | null;
  frozenAt: string | null;
}

/** All local dates in [from, to] inclusive (noon-UTC pivot → DST-safe). */
export function datesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  // Guard against a reversed range or a runaway loop (cap at ~2 years).
  for (let i = 0; i < 800 && cur <= to; i++) {
    out.push(cur);
    const d = new Date(cur + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

/**
 * The five-star day for every date in [from, to] inclusive. For each date: the frozen
 * daily_recap row if present (frozen_at set), else a live computeStars. One range query
 * backs a whole calendar month. Owner-scoped.
 */
export async function listDayStars(owner: string, from: string, to: string): Promise<DayStarsRow[]> {
  const frozenRows = await store()
    .prepare(
      // Only rows with frozen_at set are frozen; un-frozen daily_recap rows
      // (created by the summary writer) fall through to a live computeStars.
      `SELECT date, star_objective, star_habits, star_tasks, star_bonus, star_note, total
         FROM daily_recap
        WHERE owner_id = ? AND frozen_at IS NOT NULL AND date >= ? AND date <= ?`,
    )
    .all<{
      date: string; star_objective: number; star_habits: number; star_tasks: number;
      star_bonus: number; star_note: number; total: number;
    }>(owner, from, to);
  const frozen = new Map(frozenRows.map((r) => [r.date, r]));

  const out: DayStarsRow[] = [];
  for (const date of datesInRange(from, to)) {
    const f = frozen.get(date);
    if (f) {
      out.push({
        date,
        objective: !!f.star_objective,
        habits: !!f.star_habits,
        tasks: !!f.star_tasks,
        bonus: !!f.star_bonus,
        note: !!f.star_note,
        total: f.total,
        frozen: true,
      });
      continue;
    }
    const s = await computeStars(owner, date);
    out.push({ date, ...s, frozen: false });
  }
  return out;
}

/**
 * The stored daily_recap row for one (owner, date) — the frozen star snapshot co-located
 * with the mutable summary cache. Returns null when no row has been written for that day
 * (neither the freeze job nor the summarizer has touched it). Read-only: unlike GET
 * /api/stars this NEVER falls back to a live computeStars — it reflects what is on disk.
 */
export async function getDailyRecap(owner: string, date: string): Promise<DailyRecapRow | null> {
  const row = await store()
    .prepare(
      `SELECT date, prose, stats, focus, llm, inputs_hash,
              star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at
         FROM daily_recap
        WHERE owner_id = ? AND date = ?`,
    )
    .get<{
        date: string; prose: string | null; stats: string | null; focus: string | null;
        llm: number | null; inputs_hash: string | null;
        star_objective: number | null; star_habits: number | null; star_tasks: number | null;
        star_bonus: number | null; star_note: number | null; total: number | null;
        frozen_at: string | null;
      }>(owner, date);
  if (!row) return null;
  const bool = (n: number | null): boolean | null => (n == null ? null : !!n);
  return {
    date: row.date,
    prose: row.prose,
    stats: row.stats,
    focus: row.focus,
    llm: bool(row.llm),
    inputsHash: row.inputs_hash,
    objective: bool(row.star_objective),
    habits: bool(row.star_habits),
    tasks: bool(row.star_tasks),
    bonus: bool(row.star_bonus),
    note: bool(row.star_note),
    total: row.total,
    frozenAt: row.frozen_at,
  };
}
