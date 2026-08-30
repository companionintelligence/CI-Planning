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
