import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { localDateInTZ } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { dimensionShortfalls, weekBoundsFor } from './balance-budget.js';
import { priorWeekAnchor } from './plan-week-review.js';

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
 *  of frozen history the readout will ever look back over. The retrieval SQL uses
 *  `HISTORY_WEEKS_MAX * 6` as its row LIMIT (six being a generous per-owner dimension
 *  count), so the query itself is bounded regardless of how long the log has been
 *  accruing — never unbounded. */
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

// Finished time_entries attributed to a dimension via their task's category — the
// SQL_CATEGORY_ENTRIES shape (services/triality-vector.ts:206), narrowed to the target
// week's UTC range instead of a rolling "recent" window. Unlike
// `scheduledMinutesByDimension` (services/balance-budget.ts), this does NOT clamp an
// entry's minutes to the window — it filters on `started_at` falling inside it, exactly
// as SQL_CATEGORY_ENTRIES does; a timed entry is a point-in-time actual, not a span that
// straddles week edges the way a calendar block can.
const SQL_TIMED_CATEGORY_ENTRIES = `
  SELECT g.name AS category, e.started_at, e.ended_at
    FROM time_entries e
    JOIN entity_categories ec ON ec.entity_kind = 'task' AND ec.entity_id = e.task_id
    JOIN tags g ON g.id = ec.category_tag_id AND g.kind = 'category' AND g.is_base = 1 AND g.owner_id = ?
   WHERE e.owner_id = ? AND e.ended_at IS NOT NULL
     AND e.started_at >= ? AND e.started_at <= ?
`;

/** Finished-entry minutes; a malformed pair (end before start) contributes nothing —
 *  mirrors `entryMinutes` (services/triality-vector.ts:243). */
function entryMinutes(startedAt: string, endedAt: string): number {
  const mins = (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000;
  return Number.isFinite(mins) && mins > 0 ? mins : 0;
}

/** Timed minutes this week per dimension (category name) for `ownerId`, keyed by the
 *  same UTC range `weekBoundsFor` produces. Sparse: a dimension with zero finished
 *  entries this week is simply absent from the map. */
async function timedMinutesByDimension(
  ownerId: string,
  startUtc: string,
  endUtc: string,
): Promise<Map<string, number>> {
  const rows = await store()
    .prepare(SQL_TIMED_CATEGORY_ENTRIES)
    .all<{ category: string; started_at: string; ended_at: string }>(ownerId, ownerId, startUtc, endUtc);
  const out = new Map<string, number>();
  for (const r of rows) {
    const minutes = entryMinutes(r.started_at, r.ended_at);
    if (minutes > 0) out.set(r.category, (out.get(r.category) ?? 0) + minutes);
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
 * Bounded retrieval: the query pulls at most `HISTORY_WEEKS_MAX * 6` rows (newest
 * `week_start` first) across every dimension, never unbounded. Each dimension is then
 * capped to the newest `HISTORY_WEEKS_MAX` of ITS OWN rows in that set — the SQL LIMIT
 * only bounds the total fetch; a log with fewer than six dimensions could otherwise
 * return more than 12 weeks for one of them.
 */
export async function balanceHistory(ownerId: string): Promise<BalanceHistoryResult> {
  const rows = await store()
    .prepare(
      `SELECT week_start, category, target_hours, scheduled_minutes
         FROM balance_week_log WHERE owner_id = ? ORDER BY week_start DESC LIMIT ?`,
    )
    .all<BalanceWeekLogRow>(ownerId, HISTORY_WEEKS_MAX * 6);

  const weeksRecorded = new Set(rows.map((r) => r.week_start)).size;

  // Rows arrive week_start DESC already (the SQL ORDER BY), so grouping preserves that
  // order within each category — no re-sort needed before capping/slicing below.
  const byCategory = new Map<string, BalanceWeekLogRow[]>();
  for (const r of rows) {
    const list = byCategory.get(r.category);
    if (list) list.push(r);
    else byCategory.set(r.category, [r]);
  }

  const dimensions: BalanceHistoryDimension[] = [];
  for (const [category, all] of byCategory) {
    const capped = all.slice(0, HISTORY_WEEKS_MAX);
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
