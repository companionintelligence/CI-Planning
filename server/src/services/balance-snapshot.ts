import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { localDateInTZ } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { dimensionShortfalls, weekBoundsFor } from './balance-budget.js';
import { priorWeekAnchor } from './plan-week-review.js';
import { SQL_CATEGORY_ENTRIES, entryMinutes } from './triality-vector.js';

/**
 * services/balance-snapshot.ts — the balance-targets wave's durable-evidence stage
 * (docs/factory/balance-targets-wave/bal-6-week-log.md). Freezes the PREVIOUS completed
 * week's target/scheduled/timed numbers per dimension into `balance_week_log`, an
 * append-only, owner-scoped history. Ticket 1's `dimensionShortfalls` already answers
 * "target vs. scheduled for the week containing this anchor" — this module trusts that
 * rather than re-deriving it, and adds only the third leg (timed minutes, from finished
 * `time_entries`) that ticket 1 deliberately does not compute.
 *
 * Batch-only, no LLM, no learning: this ticket writes history, it does not read it back
 * (ticket 7 adds the readout) and is not gated by `balance_bias_enabled` — history
 * accrues regardless, like `classification_log` does with learning surfaces off.
 */

export interface SnapshotBalanceWeekResult {
  weekStart: string;
  /** Rows actually inserted this call — 0 on a re-run (INSERT OR IGNORE) or when the
   *  owner has no `life_priorities` rows at all. */
  rows: number;
}

/** Bal-7 (docs/factory/balance-targets-wave/bal-7-history-readout.md) — the most weeks
 *  of frozen history the readout will ever look back over, per dimension. Enforced by
 *  a `ROW_NUMBER() OVER (PARTITION BY category ...)` window in `balanceHistory`'s
 *  query, not by a total-row LIMIT — `life_priorities.category` has no server-side cap
 *  on how many distinct dimensions an owner can have (code-review fix: an earlier
 *  version used `LIMIT HISTORY_WEEKS_MAX * 6`, assuming at most 6 categories, which
 *  silently under-reported history for any owner with more). */
export const HISTORY_WEEKS_MAX = 12;

interface BalanceWeekLogRow {
  week_start: string;
  category: string;
  target_hours: number;
  scheduled_minutes: number;
}

export interface BalanceHistoryWeek {
  week_start: string;
  met: boolean;
}

export interface BalanceHistoryDimension {
  category: string;
  met_weeks: number;
  counted_weeks: number;
  /** Newest-first, already capped to `HISTORY_WEEKS_MAX`. */
  recent: BalanceHistoryWeek[];
}

export interface BalanceHistoryResult {
  weeks_recorded: number;
  dimensions: BalanceHistoryDimension[];
}

/** Timed minutes this week per dimension (category name) for `ownerId`, keyed by the
 *  same UTC range `weekBoundsFor` produces. Sparse: a dimension with zero finished
 *  entries this week is simply absent from the map.
 *
 *  Reuses `SQL_CATEGORY_ENTRIES`/`entryMinutes` from `services/triality-vector.ts`
 *  (code-review fix: this used to be a private near-duplicate of both, differing only
 *  in the query's output alias — `cat` there, which this now reads directly instead
 *  of re-aliasing to `category`). Narrowed to the target week's UTC range instead of
 *  triality's rolling "recent" window; does NOT clamp an entry's minutes to the
 *  window like `scheduledMinutesByDimension` (services/balance-budget.ts) does for
 *  calendar blocks — it filters on `started_at` falling inside it, exactly as
 *  `SQL_CATEGORY_ENTRIES` does, because a timed entry is a point-in-time actual, not
 *  a span that straddles week edges the way a calendar block can. */
async function timedMinutesByDimension(
  ownerId: string,
  startUtc: string,
  endUtc: string,
): Promise<Map<string, number>> {
  const rows = await store()
    .prepare(SQL_CATEGORY_ENTRIES)
    .all<{ cat: string; started_at: string; ended_at: string }>(ownerId, ownerId, startUtc, endUtc);
  const out = new Map<string, number>();
  for (const r of rows) {
    const minutes = entryMinutes(r.started_at, r.ended_at);
    if (minutes > 0) out.set(r.cat, (out.get(r.cat) ?? 0) + minutes);
  }
  return out;
}

/**
 * Freeze the previous completed week's per-dimension target/scheduled/timed numbers for
 * `ownerId` into `balance_week_log`. "Previous completed week" = `weekBoundsFor` on
 * owner-local (today − 7 days), the same "prior week" anchor `defaultAnchorForOwner`
 * (services/plan-week-review.ts) already uses for the FTUE weekly recap — anchoring on
 * today would freeze the in-progress week.
 *
 * One row per dimension the owner has a `life_priorities` row for (a target of 0 hours
 * still snapshots — target 0 is evidence). `INSERT OR IGNORE` in one transaction:
 * first-freeze-wins, so a re-run or a later calendar edit never mutates an already-frozen
 * row (the `freeze_stars` doctrine). Never throws for an owner with no priorities —
 * `rows: 0` is the normal, expected outcome.
 */
export async function snapshotBalanceWeek(ownerId: string, now: Date): Promise<SnapshotBalanceWeekResult> {
  const tz = await ownerTimezone(ownerId);
  const localToday = localDateInTZ(now.toISOString(), tz);
  const anchor = priorWeekAnchor(localToday);
  const { weekStart, startUtc, endUtc } = weekBoundsFor(anchor);

  const [shortfalls, timed] = await Promise.all([
    dimensionShortfalls(ownerId, anchor),
    timedMinutesByDimension(ownerId, startUtc, endUtc),
  ]);

  const createdAt = new Date().toISOString();
  let rows = 0;
  await store().transaction(async () => {
    for (const s of shortfalls) {
      const { changes } = await store()
        .prepare(
          `INSERT OR IGNORE INTO balance_week_log
             (id, owner_id, week_start, category, target_hours, scheduled_minutes, timed_minutes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId(), ownerId, weekStart, s.category, s.target_hours, s.scheduled_minutes, timed.get(s.category) ?? 0, createdAt);
      rows += changes;
    }
  });

  return { weekStart, rows };
}

/**
 * Read back the frozen history for `ownerId`, per dimension, for the drawer's
 * "met target N of last M weeks" readout (bal-7). This is `balance_week_log`'s ONLY
 * reader — the wave invariant (ticket 6's header): bias, prompts and the engine never
 * see this table, only this function does.
 *
 * "Met" = `scheduled_minutes >= target_hours * 60` for a week-row with
 * `target_hours > 0`. A `target_hours = 0` week is excluded from BOTH `met_weeks` and
 * `counted_weeks` (and always reports `met: false` in `recent`) — a week with no
 * target can be neither met nor missed. Deliberately keyed on `scheduled_minutes`
 * (the calendar), not `timed_minutes`: the wave's apply acts on the calendar, so the
 * readout has to track the same measure the bias acts on, not a different "actuals"
 * number that would silently disagree with it. (`timed_minutes` stays recorded in the
 * table for a future wave.)
 *
 * Bounded retrieval: a `ROW_NUMBER() OVER (PARTITION BY category ORDER BY
 * week_start DESC)` window caps each dimension to its own newest `HISTORY_WEEKS_MAX`
 * rows independently — never unbounded, and correct regardless of how many distinct
 * dimensions the owner has (code-review fix: a plain `LIMIT HISTORY_WEEKS_MAX * 6`
 * across all dimensions combined assumed at most 6 categories and silently
 * under-reported history for any owner with more, since `life_priorities.category`
 * has no such server-side cap).
 */
export async function balanceHistory(ownerId: string): Promise<BalanceHistoryResult> {
  const rows = await store()
    .prepare(
      `SELECT week_start, category, target_hours, scheduled_minutes FROM (
         SELECT week_start, category, target_hours, scheduled_minutes,
                ROW_NUMBER() OVER (PARTITION BY category ORDER BY week_start DESC) AS rn
           FROM balance_week_log WHERE owner_id = ?
       ) WHERE rn <= ?
       ORDER BY category, week_start DESC`,
    )
    .all<BalanceWeekLogRow>(ownerId, HISTORY_WEEKS_MAX);

  const weeksRecorded = new Set(rows.map((r) => r.week_start)).size;

  // Rows arrive week_start DESC within each category already (the SQL ORDER BY), so
  // grouping preserves that order — no re-sort needed, and every group is already
  // capped to HISTORY_WEEKS_MAX by the window filter above.
  const byCategory = new Map<string, BalanceWeekLogRow[]>();
  for (const r of rows) {
    const list = byCategory.get(r.category);
    if (list) list.push(r);
    else byCategory.set(r.category, [r]);
  }

  const dimensions: BalanceHistoryDimension[] = [];
  for (const [category, capped] of byCategory) {
    const counted = capped.filter((r) => r.target_hours > 0);
    const metRows = counted.filter((r) => r.scheduled_minutes >= r.target_hours * 60);
    dimensions.push({
      category,
      met_weeks: metRows.length,
      counted_weeks: counted.length,
      recent: capped.map((r) => ({
        week_start: r.week_start,
        met: r.target_hours > 0 && r.scheduled_minutes >= r.target_hours * 60,
      })),
    });
  }

  return { weeks_recorded: weeksRecorded, dimensions };
}
