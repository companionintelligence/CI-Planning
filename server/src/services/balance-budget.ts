import { store } from '../db/store.js';
import { weekDays } from '../lib/tz.js';

/**
 * services/balance-budget.ts — the single deterministic READ answering, per life
 * dimension, "what did the owner ask for this week (life_priorities.target_hours_per_week),
 * what is on the calendar (time_blocks that count), and how short are they?"
 *
 * Every other ticket in the balance-targets wave (bias bands, suggest surface, weekly
 * history log) consumes THIS service rather than re-deriving the shortfall math — build
 * it once, here (docs/factory/balance-targets-wave/bal-1-shortfall-service.md).
 *
 * Instruction, not evidence — so a live read is legal (wave README, "Decisions of
 * record", decision 2). The house pattern (services/classification-learning.ts) forbids
 * *learning* online, but a stated target is not learned evidence — it is a direct
 * instruction, the same class as a dayObstacle or a theme tag. Reading life_priorities +
 * the current week's calendar state at request/placement time is a pure READ of
 * user-stated config, not a violation. What IS held to the batch contract is the
 * HISTORY (the weekly shortfall snapshot, ticket 6's `balance_week_log`) — durable,
 * cron-written, and the only thing any future learning may read. Nothing in this module
 * writes anything, ever.
 *
 * Pure read, like `suggestEstimate` (services/calibration.ts:312): no table, no
 * migration, no cron. No import from `engine/*` or `agents/*` — this ticket has no
 * production caller; tickets 3–6 wire it in. Every query below filters `owner_id`; no
 * cross-owner aggregate.
 */

/** Below this a dimension never enters a bias lead set — see `biasLeadDimensions`. */
export const SHORTFALL_FLOOR_HOURS = 2;
/** At most this many dimensions lead a placement bias — see `biasLeadDimensions`. */
export const BIAS_DIMENSIONS_MAX = 2;

export interface DimensionShortfall {
  category: string;
  target_hours: number;
  scheduled_minutes: number;
  shortfall_minutes: number;
}

// ── week math — `weekDays` from `lib/tz.js` (code-review fix: this used to be a
// private copy, byte-identical to services/weekly-review.ts's own private copy and to
// a third copy inlined in lib/tz.ts's isoWeekKey — all three now share one) ──

/**
 * Owner-local Monday-start week bounds for `anchorLocalDate` (a `YYYY-MM-DD` — callers
 * pass `todayInTZ(ownerTimezone)`). UTC range = `days[0]+'T00:00:00.000Z'` →
 * `days[6]+'T23:59:59.999Z'`, exactly as `weeklyReview` builds it — this ignores the
 * owner's UTC offset at the week edges, the same accepted imprecision `weeklyReview`
 * documents; not a tz-exact variant.
 */
export function weekBoundsFor(anchorLocalDate: string): { weekStart: string; startUtc: string; endUtc: string } {
  const days = weekDays(anchorLocalDate);
  return {
    weekStart: days[0],
    startUtc: `${days[0]}T00:00:00.000Z`,
    endUtc: `${days[6]}T23:59:59.999Z`,
  };
}

// ── scheduled minutes, batched (block-own-else-task derive, done in SQL) ──

// A block's effective category set is its OWN entity_categories rows, else (task-backed,
// none of its own) its task's — the `blockCategoryNames` rule (services/blocks.ts:127),
// batched via two LEFT JOINs + a NOT EXISTS guard instead of calling that single-row
// helper in a loop:
//   - `own` matches the block's own category rows (0–3 rows).
//   - `viaTask` matches the task's category rows, but ONLY when `own` has none for this
//     block (the NOT EXISTS on its own ON clause) — so a block with own categories never
//     also picks up its task's, and a block with none gets exactly its task's set.
//     COALESCE per output row then picks whichever side actually matched.
// A block with N categories therefore yields N output rows here, each carrying the
// block's full [start_at, end_at] — i.e. it contributes its full minutes to each
// dimension it belongs to (no splitting), matching how the drawer's open-task list
// already treats membership.
// No block_kind filter — all block_kinds count, per the ticket.
const SQL_BLOCK_CATEGORY_MINUTES = `
  SELECT tb.start_at AS start_at, tb.end_at AS end_at, c.name AS category
    FROM time_blocks tb
    LEFT JOIN entity_categories own
      ON own.entity_kind = 'time_block' AND own.entity_id = tb.id
    LEFT JOIN entity_categories viaTask
      ON viaTask.entity_kind = 'task' AND viaTask.entity_id = tb.task_id
     AND NOT EXISTS (
           SELECT 1 FROM entity_categories x
            WHERE x.entity_kind = 'time_block' AND x.entity_id = tb.id
         )
    JOIN tags c
      ON c.id = COALESCE(own.category_tag_id, viaTask.category_tag_id)
     AND c.owner_id = ? AND c.kind = 'category' AND c.is_base = 1
   WHERE tb.owner_id = ?
     AND tb.status NOT IN ('cancelled', 'skipped', 'missed')
     AND tb.start_at <= ? AND tb.end_at >= ?
`;

/**
 * Overlap minutes of `[startAt, endAt)` clamped to `[rangeStartIso, rangeEndIso]`. A
 * malformed pair (end <= start, before or after clamping) contributes 0 — mirrors
 * `entryMinutes` (services/triality-vector.ts:236).
 */
function clampedOverlapMinutes(startAt: string, endAt: string, rangeStartIso: string, rangeEndIso: string): number {
  const s = Math.max(Date.parse(startAt), Date.parse(rangeStartIso));
  const e = Math.min(Date.parse(endAt), Date.parse(rangeEndIso));
  const mins = (e - s) / 60_000;
  return Number.isFinite(mins) && mins > 0 ? mins : 0;
}

/**
 * Minutes scheduled this week per dimension (category name) for `ownerId` — the CALENDAR
 * side of the shortfall. Counts blocks overlapping the week whose
 * `status NOT IN ('cancelled','skipped','missed')` — the didn't-happen terminals out of
 * `TERMINAL_BLOCK_STATUSES` (services/block-task-sync.ts:39; `completed` is NOT in this
 * exclusion set — it happened, so it counts). A block spanning a week edge contributes
 * only its in-week part.
 *
 * Deliberately NOT `time_entries` — timed (actual) minutes are ticket 6's snapshot
 * concern; this measures the calendar against targets. Known divergence from the client:
 * `DetailsDrawer.tsx`'s `DimensionPanel` (#587) computes its own "Scheduled" count with
 * no status filter, including cancelled/skipped/missed blocks — this service does not
 * inherit that gap (see the wave README's "found reconciling ticket 5" follow-up).
 *
 * Sparse: a dimension with zero minutes this week is simply absent from the map.
 */
export async function scheduledMinutesByDimension(ownerId: string, anchorLocalDate: string): Promise<Map<string, number>> {
  const { startUtc, endUtc } = weekBoundsFor(anchorLocalDate);
  const rows = await store()
    .prepare(SQL_BLOCK_CATEGORY_MINUTES)
    .all<{ start_at: string; end_at: string; category: string }>(ownerId, ownerId, endUtc, startUtc);

  const out = new Map<string, number>();
  for (const r of rows) {
    const minutes = clampedOverlapMinutes(r.start_at, r.end_at, startUtc, endUtc);
    if (minutes > 0) out.set(r.category, (out.get(r.category) ?? 0) + minutes);
  }
  return out;
}

// ── per-dimension shortfall ──

const SQL_LIFE_PRIORITIES = `SELECT category, target_hours_per_week AS target FROM life_priorities WHERE owner_id = ?`;

/**
 * Per-dimension target vs. scheduled for `ownerId`'s stated `life_priorities`, for the
 * week containing `anchorLocalDate`. One row per dimension the owner has a
 * `life_priorities` row for (a target of 0 hours yields `shortfall_minutes: 0`, not an
 * absent row) — `[]` when the owner has no `life_priorities` rows at all. Sorted
 * shortfall-desc then category asc, so ordering is deterministic for downstream callers
 * (e.g. `biasLeadDimensions`) without their own sort.
 */
export async function dimensionShortfalls(ownerId: string, anchorLocalDate: string): Promise<DimensionShortfall[]> {
  const [targets, scheduled] = await Promise.all([
    store().prepare(SQL_LIFE_PRIORITIES).all<{ category: string; target: number }>(ownerId),
    scheduledMinutesByDimension(ownerId, anchorLocalDate),
  ]);

  return targets
    .map(({ category, target }): DimensionShortfall => {
      const scheduled_minutes = scheduled.get(category) ?? 0;
      const shortfall_minutes = Math.max(0, target * 60 - scheduled_minutes);
      return { category, target_hours: target, scheduled_minutes, shortfall_minutes };
    })
    .sort((a, b) => b.shortfall_minutes - a.shortfall_minutes || a.category.localeCompare(b.category));
}

/**
 * Which dimensions should lead a placement bias this week — pure, no I/O (tickets 3/4
 * apply this; see the wave README's "Bounded influence, never suppression" ruling).
 * Filters to `shortfall_minutes >= SHORTFALL_FLOOR_HOURS*60`, then takes the first
 * `BIAS_DIMENSIONS_MAX` — worst-first because `dimensionShortfalls` already returns
 * shortfall-desc order; this function trusts that order rather than re-sorting.
 */
export function biasLeadDimensions(shortfalls: readonly DimensionShortfall[]): string[] {
  return shortfalls
    .filter((s) => s.shortfall_minutes >= SHORTFALL_FLOOR_HOURS * 60)
    .slice(0, BIAS_DIMENSIONS_MAX)
    .map((s) => s.category);
}
