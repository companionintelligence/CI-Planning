/**
 * Two-step Auto over the flight-plan (Phase G ticket G4 / A′ reframe; placement
 * model redesigned in PR-C+ Workstream A).
 *
 *  - **Step 1** (no SELECTED staged items) → propose open-task candidates *into*
 *    the flight-plan (unselected); schedule nothing.
 *  - **Step 2** (some selected) → **place** them. The placement priority is now:
 *      1. **Plans first.** For each Plan container on the day, fill it with the
 *         selected tasks that share its tag — best-fit by priority, then by
 *         tag-overlap (related work clusters). Placed tasks become the Plan's
 *         grouped members (parent_block_id), so they move with it (PR-C).
 *      1.9. **Any other matching Time Block** (`placeIntoContainers`), by the phase-5
 *         auto-nest rule — both coordinates, direction AND life-balance category.
 *         This is the plan's "matching Time Block with room first, then L01 windows":
 *         a container the Plan passes' narrower queries cannot see still gets its task.
 *      2. **Workday fallback** (secondary, gated by `auto_fill_workday`). Anything
 *         still unplaced fills open workday time, flowing *around* the Plans.
 *
 * Both passes schedule around the shared `dayObstacles` set, so nothing stacks
 * on existing work (manual or auto) and manually-placed blocks survive re-runs.
 * A single `blockId` still scopes placement to one Plan (the "Auto into this
 * Plan" affordance).
 */
import { store } from '../db/store.js';
import { AUTO_PLACED_SQL, REFLOW_CANDIDATE_SQL } from './mobility.js';
import { broadcast } from '../routes/sse.js';
import { serverTimezone, zonedWallTimeToUTC, utcDayBounds, localDateInTZ, todayInTZ } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { inheritContainerDirection, removeEntityTags, entityTagLevels, splitTagString, entityCategoryIds, categoryIdsForOwner } from '../services/tags.js';
import { localISODate } from '../lib/dates.js';
import { newId } from '../lib/ids.js';
import { buildGaps, pickGap, splitIntoSessions, dayObstacles, MS_PER_MIN } from './scheduler.js';
import { mirrorEnginePlacement, revertTaskPlacementStatus, applyTaskPlacementStatus, TERMINAL_BLOCK_STATUS_SQL } from '../services/block-task-sync.js';
import { getPatternBlocks, directionWindowsByName, FALLBACK_FILL_DIRECTION_NAMES, HOME_DIRECTION_NAME } from '../services/pattern-blocks.js';
import { resolveDayType } from '../services/day-types.js';
import { getPatternPrefs } from '../services/pattern-prefs.js';
import { nestCandidatesInRange, preferredContainers, taskNestCoords } from '../services/auto-nest.js';
import { dimensionShortfalls, biasLeadDimensions } from '../services/balance-budget.js';
import { logger } from '../lib/logger.js';

const DEFAULT_EST_MIN = 30;
const MIN_SESSION_MS = 15 * MS_PER_MIN;
const CANDIDATE_LIMIT = 20;
// bal-3: how much further than CANDIDATE_LIMIT the fill looks when a life dimension
// is running short, so a backlog task in a neglected category can still be seen —
// wide enough to surface it, bounded so the fill can't scan an unbounded backlog.
const WIDEN_FACTOR = 3;

export interface AutoResult {
  step: 'fill' | 'place';
  candidatesAdded?: number;
  blocksCreated?: number;
  placed?: number;
  unplaced?: number;
  placedInPlans?: number;    // step 2: tasks that landed inside a Plan
  placedInWorkday?: number;  // step 2: tasks that landed in the workday fallback
  days?: number;             // T-SCHED-2: how many days a Schedule-mode horizon run spanned (>1 only)
  llm?: boolean;             // T9: true iff at least one authored day's source was 'llm'
}

interface StagedTask {
  task_id: string;
  title: string;
  estimated_minutes: number | null;
  priority: number;
  due_at: string | null;
  scheduled_for: string | null; // AD1: START-day intent (owner-local YYYY-MM-DD)
  task_time: string | null;     // AD1: wall-clock HH:MM pin — placed exactly at (day, time)
  created_at: string | null;    // UTC ISO — read only by the 'new_today' fill order
  tags: string[];
}
interface PrefsRow {
  timezone: string | null;
  min_break_minutes: number | null;
  max_focus_block_minutes: number | null;
  auto_fill_workday: number | null;
  fill_order: string | null;
  default_time_block_minutes: number | null;
}
interface PlanRow {
  id: string;
  start_at: string;
  end_at: string;
  tag: string | null;
  catch_all: number;
}

/**
 * AF-11 Slice 1 (D1: preserve intention-driven matching) — the task-side MATCH set
 * is level 1 ∪ level 2. Post-0121 a task's intentions live at level 2 (direction
 * stays the sole level-1 primary), so an L1-only read here would silently stop
 * intention tags from pulling tasks into same-named tagged Plans (Pass 1 / the
 * single-Plan path), NL hint windows, and orderForPlan's overlap/plan scoring.
 * L1 ∪ L2 is exactly the pre-split flat set, so those consumers are byte-identical.
 *
 * Direction-only passes are UNAFFECTED by the widening because they never consume
 * `StagedTask.tags` raw — they map names through kind='direction' lookups:
 *  - Pass 2a maps via dirNameToId (built from tags WHERE kind='direction');
 *  - categoryCandidates' opt-out check maps via patNameToId (kind='direction');
 *  - placeStartAnchoredTask queries entity_tags level=1 AND kind='direction' in SQL.
 * An intention name in the set resolves to no direction id and drops out.
 * (A tag exists at exactly ONE level — the entity_tags PK excludes level — so the
 * union has no duplicates.)
 */
async function tagsOf(taskId: string): Promise<string[]> {
  return (await entityTagLevels('task', taskId)).map((t) => t.name);
}

/**
 * Selected staged tasks, ordered by `daily_plan.position` when an authored day plan
 * exists for `date` (Phase M §0 / A1). Tasks with no `daily_plan` row (e.g. added
 * after authoring) fall through to the original `fp.position` ordering so nothing
 * is ever silently dropped.
 */
async function selectedStaged(owner: string, date: string): Promise<StagedTask[]> {
  const rows = await store()
    .prepare(
      `SELECT fp.task_id, t.title, t.estimated_minutes, t.priority, t.due_at, t.scheduled_for, t.task_time, t.created_at
         FROM flight_plan fp
         JOIN tasks t ON t.id = fp.task_id
         LEFT JOIN daily_plan dp
           ON dp.owner_id = fp.owner_id AND dp.task_id = fp.task_id AND dp.date = ?
        WHERE fp.owner_id = ? AND fp.selected = 1
        ORDER BY CASE WHEN dp.position IS NULL THEN 1 ELSE 0 END,
                 COALESCE(dp.position, fp.position),
                 t.priority, fp.task_id`
    )
    .all(date, owner) as Omit<StagedTask, 'tags'>[];
  return await Promise.all(rows.map(async (r) => ({ ...r, priority: r.priority ?? 3, tags: await tagsOf(r.task_id) })));
}

/**
 * Build the StagedTask list for an explicit task-id set, PRESERVING the caller's
 * order (reflow passes the day's authored order with current-block order appended).
 * Bypasses `flight_plan` entirely: a reflow re-places what is ON THE BOARD, and must
 * not write to — or read through — the user's staging area (the old restage inserted
 * rows there and leaked every re-place failure into the flight-plan UI).
 */
async function stagedFromTaskIds(owner: string, ids: readonly string[]): Promise<StagedTask[]> {
  if (ids.length === 0) return [];
  const rows = await store()
    .prepare(
      `SELECT id AS task_id, title, estimated_minutes, priority, due_at, scheduled_for, task_time, created_at
         FROM tasks WHERE owner_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(owner, ...ids) as Omit<StagedTask, 'tags'>[];
  const byId = new Map(rows.map((r) => [r.task_id, r]));
  const found = ids
    .map((id) => byId.get(id))
    .filter((r): r is Omit<StagedTask, 'tags'> => r !== undefined);
  return await Promise.all(found.map(async (r) => ({ ...r, priority: r.priority ?? 3, tags: await tagsOf(r.task_id) })));
}

/** How many tasks are staged in the flight-plan (selected or not). */
async function flightPlanCount(owner: string): Promise<number> {
  return (await store().prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ?`).get(owner) as { n: number }).n;
}

/** Record the most recent placement run for the owner, so Undo can target it (D2). */
async function recordRun(owner: string, runId: string, blocksCreated: number): Promise<void> {
  if (blocksCreated > 0) await store().prepare(`UPDATE owners SET last_auto_run_id = ? WHERE id = ?`).run(runId, owner);
}

async function prefsOf(owner: string): Promise<PrefsRow | undefined> {
  return await store()
    .prepare(`SELECT timezone, min_break_minutes, max_focus_block_minutes, auto_fill_workday, fill_order, default_time_block_minutes FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as PrefsRow | undefined;
}

/** Tagged, timed Plan containers on `date`, earliest first. */
async function dayPlans(owner: string, date: string, tz: string): Promise<PlanRow[]> {
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  return await store()
    .prepare(
      `SELECT tb.id, tb.start_at, tb.end_at, tb.tag,
              COALESCE((SELECT pt.catch_all FROM pattern_types pt
                         WHERE pt.name = tb.tag AND pt.catch_all = 1 LIMIT 1), 0) AS catch_all
         FROM time_blocks tb
        WHERE tb.owner_id = ? AND tb.block_kind = 'timeblock' AND tb.block_type = 'scheduled' AND tb.tag IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM entity_categories ec
                           WHERE ec.entity_kind = 'time_block' AND ec.entity_id = tb.id)
          AND COALESCE(tb.all_day, 0) = 0
          AND tb.start_at < ? AND tb.end_at > ?
        ORDER BY tb.start_at, tb.id`
    )
    .all(owner, dayEndISO, dayStartISO) as PlanRow[];
}

interface CategoryPlanRow { id: string; start_at: string; end_at: string; category_id: string }

/**
 * Category-tagged, timed Plan containers on `date`, earliest first (0069). Disjoint
 * from dayPlans by the SQL filters themselves: dayPlans requires NO entity_categories
 * rows, this pass requires the position-0 row — so no block is ever filled by both
 * passes, even now that AF-4 lets a block carry a tag AND a category (a both-set
 * container is filled by THIS pass, keyed on its category).
 *
 * Phase B (0135): the category axis moved to `entity_categories` (time_blocks.category_id
 * is retired from the write path; 0135 backfilled surviving values). A multi-category
 * Plan is filled by its POSITION-0 category — the fill axis is singular by design; the
 * stripes are a render concern.
 */
async function dayCategoryPlans(owner: string, date: string, tz: string): Promise<CategoryPlanRow[]> {
  // Same DST-aware day window as dayPlans directly above — a start+24h add drifts
  // an hour off local midnight on the two DST-transition days.
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  return await store()
    .prepare(
      `SELECT tb.id, tb.start_at, tb.end_at, ec.category_tag_id AS category_id
         FROM time_blocks tb
         JOIN entity_categories ec
           ON ec.entity_kind = 'time_block' AND ec.entity_id = tb.id AND ec.position = 0
        WHERE tb.owner_id = ? AND tb.block_kind = 'timeblock' AND tb.block_type = 'scheduled'
          AND COALESCE(tb.all_day, 0) = 0
          AND tb.start_at < ? AND tb.end_at > ?
        ORDER BY tb.start_at, tb.id`
    )
    .all(owner, dayEndISO, dayStartISO) as CategoryPlanRow[];
}

/**
 * Staged tasks eligible for a category Plan (0069), by EITHER route:
 *
 *   1. the task carries the category directly — an `entity_categories` row, i.e. what the
 *      wizard's 1–3 category picker and the quick-add classifier write (Phase B, 0134/0135);
 *   2. the task has a SECONDARY tag (entity_tags level>1) that is a member of the category
 *      via the older `tag_categories` intention→category grouping (0069).
 *
 * …AND a direction that is NOT fully opted out for the category.
 *
 * Route 1 was missing, which made the two halves of a category block disagree: the BLOCK's
 * category is read from `entity_categories` (dayCategoryPlans, and `entityCategoryIds` on
 * the single-Plan path), but candidates were matched only through the intention grouping.
 * So a task the user explicitly tagged "Relationships" with the picker was never placed
 * into a Relationships block unless it also happened to carry a Relationships-grouped
 * intention tag — the feature looked wired and silently did nothing. Both routes are a
 * union, so the 0069 grouping keeps working exactly as before.
 *
 * Preserves `staged` order (deterministic — id-keyed, no clock/randomness). NB: the
 * grouping route reads entity_tags level>1 directly (the canonical secondary-tag store);
 * `staged.tags` (L1 ∪ L2 since AF-11) is used only for the direction opt-out check below,
 * where non-direction names drop out via patNameToId. A direction-less task is included on
 * the category match alone. Owner scoping comes from the `staged` intersection at the end
 * (both queries are keyed on a category id that is already owner-scoped).
 */
async function categoryCandidates(staged: StagedTask[], categoryId: string, owner: string): Promise<StagedTask[]> {
  const candIds = new Set(
    (await store()
      .prepare(
        `SELECT DISTINCT entity_id FROM entity_tags
          WHERE entity_kind = 'task' AND level > 1
            AND tag_id IN (SELECT intention_tag_id FROM tag_categories WHERE category_tag_id = ?)
         UNION
         SELECT entity_id FROM entity_categories
          WHERE entity_kind = 'task' AND category_tag_id = ?`
      )
      .all(categoryId, categoryId) as { entity_id: string }[]).map((r) => r.entity_id),
  );
  if (candIds.size === 0) return [];
  const optOut = new Set(
    (await store()
      .prepare(`SELECT direction_tag_id FROM category_direction_optouts WHERE category_tag_id = ?`)
      .all(categoryId) as { direction_tag_id: string }[]).map((r) => r.direction_tag_id),
  );
  const patNameToId = new Map<string, string>();
  for (const pt of await store().prepare(`SELECT id, name FROM tags WHERE owner_id = ? AND kind = 'direction'`).all(owner) as { id: string; name: string }[]) {
    patNameToId.set(pt.name, pt.id);
  }
  return staged.filter((t) => {
    if (!candIds.has(t.task_id)) return false;
    const dirIds = t.tags.map((n) => patNameToId.get(n)).filter((id): id is string => id !== undefined);
    return dirIds.length === 0 || !dirIds.every((d) => optOut.has(d)); // include unless EVERY direction opted out
  });
}

/**
 * Phase 5 dilution: a Plan's tag→weight map. A top-level tag (level 1) weighs
 * 1.0; each secondary (level>1) weighs `1/totalTags`, so a task matching only via
 * a secondary tag ranks below one matching the Plan's primary work (top-level is
 * immune). Falls back to the `tag` mirror as top-level when the normalized store
 * has no rows for this Plan (e.g. a row predating the backfill).
 */
async function planTagWeights(planId: string, fallbackTag: string | null): Promise<Map<string, number>> {
  const levels = await entityTagLevels('time_block', planId);
  const w = new Map<string, number>();
  if (levels.length === 0) {
    for (const name of splitTagString(fallbackTag)) w.set(name, 1);
    return w;
  }
  const total = levels.length;
  for (const { name, level } of levels) w.set(name, level === 1 ? 1 : 1 / total);
  return w;
}

/**
 * Order candidates for a Plan: priority first, then — when Plan tag weights are
 * given — the diluted match strength against the Plan (top-tag matches outrank
 * secondary-tag matches), then tag-overlap "centrality" among the candidates
 * (clusters related work), then due date. Without weights (or with a single
 * top-level tag, where every matched candidate scores 1.0) the ordering is
 * unchanged from the pre-Phase-5 behavior.
 */
function orderForPlan(cands: StagedTask[], weights?: Map<string, number>): StagedTask[] {
  const freq = new Map<string, number>();
  for (const c of cands) for (const t of c.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
  const overlap = (c: StagedTask) => c.tags.reduce((s, t) => s + ((freq.get(t) ?? 1) - 1), 0);
  const planScore = (c: StagedTask) => (weights ? c.tags.reduce((s, t) => s + (weights.get(t) ?? 0), 0) : 0);
  const dueRank = (c: StagedTask) => (c.due_at ? Date.parse(c.due_at) : Number.POSITIVE_INFINITY);
  return [...cands].sort(
    (a, b) =>
      a.priority - b.priority ||
      planScore(b) - planScore(a) ||
      overlap(b) - overlap(a) ||
      dueRank(a) - dueRank(b) ||
      a.task_id.localeCompare(b.task_id)
  );
}

/**
 * Order candidates for the workday leftover fill by overdue-ness: tasks with a
 * due_at come first, sorted oldest-due first (most overdue = earliest slot);
 * tasks with no due date follow, sorted by priority then id. Never throws when
 * no tasks are overdue — undated tasks still get placed, just last.
 */
function orderByOverdue(cands: StagedTask[]): StagedTask[] {
  const dated = [...cands.filter((c) => c.due_at != null)].sort(
    (a, b) => a.due_at!.localeCompare(b.due_at!) || a.priority - b.priority || a.task_id.localeCompare(b.task_id),
  );
  const undated = [...cands.filter((c) => c.due_at == null)].sort(
    (a, b) => a.priority - b.priority || a.task_id.localeCompare(b.task_id),
  );
  return [...dated, ...undated];
}

/**
 * Order the workday leftover fill by ARRIVAL: everything created on the owner's today —
 * the Tasks tab's "New Today" set — takes the earliest slots, then the rest of the
 * backlog follows in the standard deadline-first order.
 *
 * `todayISO` is the owner's ACTUAL today, deliberately not the `date` being placed:
 * planning tomorrow must still give today's arrivals first claim, whereas keying off
 * `date` would make the mode a silent no-op on every day but today (nothing is ever
 * created on a future date).
 *
 * Membership matches the client's New Today partition — `created_at` converted to the
 * OWNER's local day, never a raw UTC compare, or a task created late evening would fall
 * out of its own bucket for anyone east/west of UTC. Within each half the existing
 * overdue ordering still applies, so this layers on top of deadline-first rather than
 * discarding it. A NULL `created_at` sorts with the older half (fail-safe: an undated
 * row never displaces a task the owner can see is new).
 */
function orderByNewToday(cands: StagedTask[], todayISO: string, tz: string): StagedTask[] {
  const isNew = (c: StagedTask) => !!c.created_at && localDateInTZ(c.created_at, tz) === todayISO;
  return [...orderByOverdue(cands.filter(isNew)), ...orderByOverdue(cands.filter((c) => !isNew(c)))];
}

const insBlock = () =>
  store().prepare(
    `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, parent_block_id, auto_run_id, tag)
     VALUES (uuid7(), ?, ?, ?, 'task', ?, ?, 0, 1, 'agent', 'planned', ?, ?, ?)`
  );

/**
 * Clear our OWN prior agent placements for the local day (pattern blocks survive).
 *
 * SCOPED to `taskIds` — the tasks this run is about to (re)place. The clear set and
 * the re-place set must be the same set: an unscoped DELETE here was the reflow-wipe
 * bug (and its explicit-path twin: a second Auto run of the day deleted the first
 * run's placements, which were no longer staged). An empty `taskIds` clears nothing.
 *
 * Terminal statuses are never cleared — including 'missed'/'cancelled', which the old
 * filter deleted despite the snapshot/obstacle queries treating them as settled
 * history (the review surface's missed-evidence blocks vanished on every reflow).
 *
 * `protectIds` — block ids the caller wants kept regardless (auto-defense passes the
 * in-progress / recently-moved / locked blocks here, in memory, so a reflow never has
 * to write is_locked to fence them off and can't leave a block stuck locked on a crash).
 */
async function clearPriorAuto(
  owner: string,
  date: string,
  tz: string,
  opts: { taskIds: readonly string[]; protectIds?: Set<string> },
): Promise<void> {
  if (opts.taskIds.length === 0) return; // nothing to re-place → nothing to clear
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  const protect = opts.protectIds && opts.protectIds.size ? [...opts.protectIds] : [];
  const notIn = protect.length ? ` AND id NOT IN (${protect.map(() => '?').join(',')})` : '';
  await store()
    .prepare(
      `DELETE FROM time_blocks
        WHERE owner_id = ? AND ${REFLOW_CANDIDATE_SQL}
          AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
          AND task_id IN (${opts.taskIds.map(() => '?').join(',')})
          AND start_at < ? AND end_at > ?` + notIn
    )
    .run(owner, ...opts.taskIds, dayEndISO, dayStartISO, ...protect);
}

/**
 * Place `tasks` (in the order given) into [windowStartMs, windowEndMs], around
 * the live obstacle set. Returns the task ids that got at least one session.
 * Does not clear — the caller owns idempotent clearing for the whole run.
 */
async function placeIntoWindow(
  owner: string,
  tasks: StagedTask[],
  windowStartMs: number,
  windowEndMs: number,
  prefs: PrefsRow | undefined,
  opts: { parentBlockId?: string | null; includePlans?: boolean; runId?: string | null; notBeforeMs?: number | null }
): Promise<{ blocksCreated: number; placedTaskIds: Set<string> }> {
  const placedTaskIds = new Set<string>();
  // R3 clamp: an engine-chosen slot never starts before `now` (set by the caller only
  // when placing on the owner-local current day) — a late-day re-pack must fill the
  // REMAINING day, not move future work into already-past morning gaps that the missed
  // sweep would immediately recycle (a churn loop).
  if (opts.notBeforeMs != null) windowStartMs = Math.max(windowStartMs, opts.notBeforeMs);
  if (windowEndMs <= windowStartMs || tasks.length === 0) return { blocksCreated: 0, placedTaskIds };

  const breakMs = (prefs?.min_break_minutes ?? 10) * MS_PER_MIN;
  const maxFocusMs = Math.max((prefs?.max_focus_block_minutes ?? 90) * MS_PER_MIN, MIN_SESSION_MS);
  const fixed = await dayObstacles(owner, windowStartMs, windowEndMs, {
    includePlans: opts.includePlans,
    excludeBlockId: opts.parentBlockId ?? null,
  });
  const gaps = buildGaps(windowStartMs, windowEndMs, fixed, breakMs);
  const ins = insBlock();
  let blocksCreated = 0;

  // AD2: when placing INTO a Plan/container (parentBlockId set), read the container's
  // direction (`time_blocks.tag`) so each child task inherits it as its level-1 primary
  // (unless it already has one) and the child block mirrors it in `tag`. A category Plan
  // has tag NULL → inheritContainerDirection is a no-op; direction-window/workday fills
  // pass no parentBlockId, so their blocks keep tag NULL (unchanged).
  const containerTag = opts.parentBlockId
    ? ((await store().prepare(`SELECT tag FROM time_blocks WHERE id = ? AND owner_id = ?`).get(opts.parentBlockId, owner) as { tag: string | null } | undefined)?.tag ?? null)
    : null;

  for (const t of tasks) {
    if (opts.parentBlockId) await inheritContainerDirection(t.task_id, containerTag, owner);
    const sessions = splitIntoSessions((t.estimated_minutes ?? DEFAULT_EST_MIN) * MS_PER_MIN, maxFocusMs);
    let placedAny = false;
    for (const want of sessions) {
      const pick = pickGap(gaps, want);
      if (!pick) break;
      const startMs = pick.gap.cursor;
      const endMs = startMs + pick.len;
      await ins.run(t.task_id, owner, t.title, new Date(startMs).toISOString(), new Date(endMs).toISOString(), opts.parentBlockId ?? null, opts.runId ?? null, opts.parentBlockId ? containerTag : null);
      pick.gap.cursor = endMs + breakMs;
      blocksCreated++;
      placedAny = true;
    }
    if (placedAny) {
      placedTaskIds.add(t.task_id);
      // R2 parity: placed = scheduled on EVERY path — flip open → scheduled and mirror
      // the placement day (never task_time; see mirrorEnginePlacement) like the
      // wizard/container/routine placement paths already do.
      await mirrorEnginePlacement(t.task_id, owner);
    }
  }
  return { blocksCreated, placedTaskIds };
}

interface PriorPlacement { id: string; start_at: string; end_at: string }

/**
 * Day-scoped idempotency for a stated-day placement (H4). Returns the existing block to
 * treat AS the placement — a still-active block already on the target local day, or a
 * user-LOCKED pin on any day (never fight a deliberate pin) — else null after deleting
 * this task's stale UNLOCKED active blocks on OTHER days (the "move": honoring a newly
 * stated day must not leave a duplicate on the old one).
 *
 * The pre-H4 check treated ANY active block anywhere as "already placed", so a leftover
 * block on a different day silently suppressed the stated (scheduled_for, task_time) —
 * the task read as placed while its only block sat on the wrong (often past) day.
 */
async function reconcilePriorPlacement(owner: string, taskId: string, dayStartISO: string, dayEndISO: string): Promise<PriorPlacement | null> {
  const sameDay = await store()
    .prepare(
      `SELECT id, start_at, end_at FROM time_blocks
        WHERE task_id = ? AND owner_id = ? AND block_kind = 'task'
          AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
          AND start_at < ? AND end_at > ?
        ORDER BY start_at LIMIT 1`,
    )
    .get(taskId, owner, dayEndISO, dayStartISO) as PriorPlacement | undefined;
  if (sameDay) return sameDay;

  const lockedElsewhere = await store()
    .prepare(
      `SELECT id, start_at, end_at FROM time_blocks
        WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND is_locked = 1
          AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
        ORDER BY start_at LIMIT 1`,
    )
    .get(taskId, owner) as PriorPlacement | undefined;
  if (lockedElsewhere) return lockedElsewhere;

  // No same-day and no locked block anywhere → only stale UNLOCKED blocks on other days
  // remain (if any). Delete them so honoring the stated day doesn't leave a duplicate.
  // CON-3 cascade: these are HARD-deleted, so clear their entity_tags rows too
  // (entity_tags.entity_id has no FK — an orphan would break tag-integrity), mirroring
  // review.ts's dropBlocks/rescheduleTask cleanup.
  const stale = await store()
    .prepare(
      `DELETE FROM time_blocks
        WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND is_locked = 0
          AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
        RETURNING id`,
    )
    .all(taskId, owner) as { id: string }[];
  for (const b of stale) await removeEntityTags('time_block', b.id);
  return null;
}

/**
 * AD1 — pin a `task_time` staged task at (date, task_time) when its target day was
 * derived from due_at only (no scheduled_for, so placeStartAnchoredTask — which reads
 * scheduled_for — can't be used). Same semantics as that path's exact-time branch:
 * one is_auto=0 user-intent block at the exact instant; on conflict, the open gap
 * NEAREST the requested time the SAME local day. Idempotent (skips if an active block
 * already exists) and silent (the caller's run broadcasts once at the end). Returns
 * whether a block now exists for the task. Plan containers are NOT obstacles for the
 * exact hit — a stated time inside a Plan is normal grouping, not double-booking.
 */
async function pinTaskAt(
  owner: string,
  t: StagedTask,
  date: string,
  tz: string,
  prefs: PrefsRow | undefined,
  notBeforeMs?: number | null,
): Promise<boolean> {
  // H4: idempotent ONLY against a block already on the target day (or a locked pin
  // anywhere); a stale unlocked block on another day is cleared so the stated day wins.
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  const existing = await reconcilePriorPlacement(owner, t.task_id, dayStartISO, dayEndISO);
  if (existing) {
    await store().prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`).run(owner, t.task_id);
    await applyTaskPlacementStatus(t.task_id, owner); // R2 parity: the existing block IS the placement
    return true;
  }

  const durMs = Math.max((t.estimated_minutes ?? prefs?.default_time_block_minutes ?? 60) * MS_PER_MIN, MIN_SESSION_MS);
  const breakMs = (prefs?.min_break_minutes ?? 10) * MS_PER_MIN;
  const create = async (startMs: number): Promise<boolean> => {
    const startAt = new Date(startMs).toISOString();
    const endAt = new Date(startMs + durMs).toISOString();
    await insAnchoredBlock().get(t.task_id, owner, t.title, startAt, endAt);
    await store().prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`).run(owner, t.task_id);
    await mirrorEnginePlacement(t.task_id, owner); // R2 parity: scheduled_for = this day, open → scheduled
    return true;
  };

  // The stated (date, task_time) instant is honored EXACTLY even if it has already
  // passed (user intent, not an engine choice) — only the gap FALLBACK below clamps.
  const startMs = Date.parse(zonedWallTimeToUTC(date, t.task_time!, tz));
  if ((await dayObstacles(owner, startMs, startMs + durMs)).length === 0) return await create(startMs);

  const bounds = utcDayBounds(date, tz);
  const dayStart = Math.max(Date.parse(bounds.start), notBeforeMs ?? Number.NEGATIVE_INFINITY);
  const dayEnd = Date.parse(bounds.end);
  let bestStart: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const g of buildGaps(dayStart, dayEnd, await dayObstacles(owner, dayStart, dayEnd), breakMs)) {
    if (g.end - g.cursor < durMs) continue;
    const s = Math.min(Math.max(startMs, g.cursor), g.end - durMs);
    const dist = Math.abs(s - startMs);
    if (dist < bestDist) { bestStart = s; bestDist = dist; }
  }
  return bestStart === null ? false : await create(bestStart);
}

/**
 * 0156 — union of one or more direction tags' pattern_blocks windows for `date`,
 * converted to UTC ms. Replaces the flat workday_start/workday_end fallback:
 * `directionWindowsByName` does the name→id lookup + DB read (shared with
 * patterns-place.ts/triality-vector.ts), this just adds the per-date wall-clock
 * conversion every caller here needs. Empty when no matching tag/window exists —
 * never a hardcoded default.
 */
async function directionWindowsMs(
  owner: string,
  dayType: string,
  date: string,
  tz: string,
  names: readonly string[],
): Promise<{ start: number; end: number }[]> {
  const ranges = await directionWindowsByName(owner, dayType, names);
  return ranges.map((r) => ({
    start: Date.parse(zonedWallTimeToUTC(date, r.start_time, tz)),
    end: Date.parse(zonedWallTimeToUTC(date, r.end_time, tz)),
  }));
}

/** Collapses a set of ranges to one earliest-start/latest-end pair, or null when empty. */
function outerBound(ranges: { start: number; end: number }[]): { start: number; end: number } | null {
  if (ranges.length === 0) return null;
  return { start: Math.min(...ranges.map((r) => r.start)), end: Math.max(...ranges.map((r) => r.end)) };
}

/**
 * Phase M A4 — place tasks constrained by natural-language tag-window hints.
 *
 * `tag_before T` / `tag_after T` (from `plan_hints`, persisted by `/api/plan/instruct`)
 * become a transient per-tag clock window for TODAY: `tag_before`→`[bound.start,T]`,
 * `tag_after`→`[T,bound.end]`, intersected when several hints touch one task. `bound`
 * is the work+community pattern-window union (0156, replacing the old flat
 * workday_start/end), widened to also include the home direction's union for a task
 * that itself carries the home tag — but only on the side no explicit hint narrowed
 * (an explicit "before 3pm" still caps the end even for a home-tagged task). Falls
 * back to the full day when the union is empty, so an owner with no configured
 * pattern_blocks can still use NL hints at all — this mirrors parseInstruction's own
 * degrade (agents/plan.ts), which must agree with this bound or a hint the LLM
 * parsed as valid could come back unplaceable here. A hinted task is placed ONLY
 * within its window. The returned `constrainedIds` are the tasks any hint touched —
 * the caller MUST exclude these from its unconstrained workday fill so a hinted task
 * is never dropped outside its window (HARD enforcement: a full/empty window leaves
 * the task unplaced, not force-filled). `batch` imposes no window — contiguity is
 * the §A2 authored-order concern. `candidates` should already be in daily_plan order so
 * same-tag tasks pack contiguously. No-op (empty sets) when the day has no timed hints.
 */
async function placeHintWindows(
  owner: string,
  date: string,
  candidates: StagedTask[],
  prefs: PrefsRow | undefined,
  tz: string,
  runId: string,
  notBeforeMs?: number | null,
): Promise<{ placedTaskIds: Set<string>; constrainedIds: Set<string>; blocksCreated: number }> {
  const placedTaskIds = new Set<string>();
  const constrainedIds = new Set<string>();
  let blocksCreated = 0;

  const hintRows = await store()
    .prepare(`SELECT kind, tag, time FROM plan_hints WHERE owner_id = ? AND date = ?`)
    .all(owner, date) as { kind: string; tag: string; time: string | null }[];
  const timed = hintRows.filter((h) => (h.kind === 'tag_before' || h.kind === 'tag_after') && h.time);
  if (timed.length === 0) return { placedTaskIds, constrainedIds, blocksCreated };

  const dayType = await resolveDayType(owner, date);
  const fullDay = { start: Date.parse(zonedWallTimeToUTC(date, '00:00', tz)), end: Date.parse(zonedWallTimeToUTC(date, '24:00', tz)) };
  const baseBound = outerBound(await directionWindowsMs(owner, dayType, date, tz, FALLBACK_FILL_DIRECTION_NAMES)) ?? fullDay;
  const homeBound = outerBound(await directionWindowsMs(owner, dayType, date, tz, [HOME_DIRECTION_NAME]));

  // tag → explicit per-side hint bound only; null = "no hint on this side", so a
  // per-task default (base or home-widened) can still apply there.
  const tagWindow = new Map<string, { start: number | null; end: number | null }>();
  for (const h of timed) {
    const tMs = Date.parse(zonedWallTimeToUTC(date, h.time!, tz));
    const cur = tagWindow.get(h.tag) ?? { start: null, end: null };
    if (h.kind === 'tag_before') cur.end = cur.end === null ? tMs : Math.min(cur.end, tMs);
    else cur.start = cur.start === null ? tMs : Math.max(cur.start, tMs);
    tagWindow.set(h.tag, cur);
  }

  for (const t of candidates) {
    const isHome = homeBound !== null && t.tags.includes(HOME_DIRECTION_NAME);
    const dflt = isHome
      ? { start: Math.min(baseBound.start, homeBound!.start), end: Math.max(baseBound.end, homeBound!.end) }
      : baseBound;
    let start = dflt.start, end = dflt.end, matched = false;
    for (const tag of t.tags) {
      const w = tagWindow.get(tag);
      if (!w) continue;
      matched = true;
      if (w.start !== null) start = Math.max(start, w.start);
      if (w.end !== null) end = Math.min(end, w.end);
    }
    if (!matched) continue;
    constrainedIds.add(t.task_id); // hard: caller excludes these from the unconstrained fill
    if (end <= start) continue;    // contradictory/empty window → leave unplaced today
    const r = await placeIntoWindow(owner, [t], start, end, prefs, { parentBlockId: null, includePlans: true, runId, notBeforeMs });
    r.placedTaskIds.forEach((id) => placedTaskIds.add(id));
    blocksCreated += r.blocksCreated;
  }
  return { placedTaskIds, constrainedIds, blocksCreated };
}

/**
 * L02-first placement — offer each still-unplaced task a matching Time Block before
 * the L01 direction windows get it.
 *
 * The plan's placement order is "matching Time Block with room first, then L01
 * windows, then unplaced", and a match is BOTH coordinates: direction and
 * life-balance category (decision 4). Phase 5 built that rule for CREATE time; this
 * is the same rule on the engine side, reading the same matcher
 * (`preferredContainers`) and the same candidate query rather than a second one.
 *
 * It is not redundant with the Plan passes above, which ask narrower questions:
 * Pass 1 matches a tag-only container on direction, Pass 1.5 matches a category
 * container on CATEGORY ALONE, and both require `block_type = 'scheduled'` — so a
 * Time Block created outside the Element wizard (block_type NULL) is invisible to
 * them while the create path nests into it happily. That gap is what sent a task
 * with a perfectly good container into a bare window.
 *
 * Decision 7 — a full Time Block never auto-extends. A container with no room simply
 * yields: the next matching container gets a turn, then L01. Tasks already claimed by
 * a Plan pass or constrained by an NL hint window never reach here.
 */
async function placeIntoContainers(
  owner: string,
  date: string,
  tasks: StagedTask[],
  prefs: PrefsRow | undefined,
  tz: string,
  runId: string,
  notBeforeMs?: number | null,
): Promise<{ placedTaskIds: Set<string>; blocksCreated: number }> {
  const placedTaskIds = new Set<string>();
  let blocksCreated = 0;
  if (tasks.length === 0) return { placedTaskIds, blocksCreated };

  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  const candidates = await nestCandidatesInRange(owner, dayStartISO, dayEndISO);
  if (candidates.length === 0) return { placedTaskIds, blocksCreated };

  const dayStartMs = Date.parse(dayStartISO);
  const dayEndMs = Date.parse(dayEndISO);

  for (const t of tasks) {
    const coords = await taskNestCoords(owner, t.task_id);
    // No direction → no coordinate to match on, exactly as at create time.
    if (coords.directions.length === 0) continue;
    for (const container of preferredContainers(coords, candidates)) {
      // Clamped to the day this run owns: a container spanning midnight would
      // otherwise take a session outside the window `clearPriorAuto` sweeps, and the
      // next run would place a second one beside it.
      const winStart = Math.max(container.startMs, dayStartMs);
      const winEnd = Math.min(container.endMs, dayEndMs);
      if (winEnd <= winStart) continue;
      const r = await placeIntoWindow(owner, [t], winStart, winEnd, prefs, {
        parentBlockId: container.id,
        runId,
        notBeforeMs,
      });
      if (!r.placedTaskIds.has(t.task_id)) continue; // full → the next container, then L01
      placedTaskIds.add(t.task_id);
      blocksCreated += r.blocksCreated;
      break;
    }
  }
  return { placedTaskIds, blocksCreated };
}

/** STEP 1: propose open-task candidates (not already staged) into the flight-plan.
 * Habits are excluded — they're auto-placed daily from their recurrence, so they
 * shouldn't flood the flight-plan as one-off candidates.
 *
 * AB1: `scheduled_for` is a START intent, so a task scheduled for a DIFFERENT day
 * never leaks into this fill's plan (`opts.date`, default today). A task scheduled
 * for the fill date itself may still stage — but only while it has no active block
 * yet (start-anchored placement usually created one already; staging it again would
 * double-book it). due_at remains ordering-only and never selects the day. */
/** Today in the OWNER's timezone (YYYY-MM-DD). `scheduled_for` is owner-local, so the
 *  fill/exclusion day must be too — comparing it to a server-tz `localISODate()` would
 *  mis-window scheduled tasks around midnight for owners in a different timezone. */
async function ownerToday(owner: string): Promise<string> {
  return todayInTZ((await prefsOf(owner))?.timezone || serverTimezone());
}

/** The open-task WHERE clause fillFlightPlanCandidates has always used, shared by the
 *  base (unbiased) fetch and bal-3's widened fetch — only `limit` differs between them,
 *  so the two paths can never drift apart on eligibility. */
function openCandidateSql(estimateClause: string): string {
  return `SELECT id FROM tasks
        WHERE owner_id = ? AND status = 'open'
          AND subtype IS NOT 'habit'
          AND parent_id IS NULL
          AND recurrence_parent_id IS NULL
          ${estimateClause}
          AND (scheduled_for IS NULL
               OR (scheduled_for = ? AND NOT EXISTS (
                     SELECT 1 FROM time_blocks tb
                      WHERE tb.task_id = tasks.id AND tb.block_kind = 'task'
                        AND tb.status NOT IN ('completed','skipped','cancelled'))))
          AND id NOT IN (SELECT task_id FROM flight_plan WHERE owner_id = ?)
        ORDER BY priority, COALESCE(due_at, '9999-12-31'), id
        LIMIT ?`;
}

async function openCandidateIds(owner: string, fillDate: string, estimateClause: string, limit: number): Promise<string[]> {
  const rows = await store().prepare(openCandidateSql(estimateClause)).all(owner, fillDate, owner, limit) as { id: string }[];
  return rows.map((r) => r.id);
}

/** bal-3: which dimensions (life_priorities.category names) should lead this fill's
 *  candidate ordering — [] whenever bias doesn't apply, so the caller's fallback to
 *  the original single-query path is always correct. Gate order is cheapest-first:
 *  the pref flag (absent row ⇒ ON, matching the column DEFAULT) short-circuits before
 *  the shortfall service ever runs. */
async function biasLeadDimensionsForFill(owner: string, fillDate: string): Promise<string[]> {
  const row = await store().prepare(`SELECT balance_bias_enabled FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as
    { balance_bias_enabled: number | null } | undefined;
  if (row?.balance_bias_enabled === 0) return [];
  const shortfalls = await dimensionShortfalls(owner, fillDate);
  return biasLeadDimensions(shortfalls);
}

/** bal-3: partition a widened candidate-id list into [leads, rest], preserving each
 *  half's original (priority, due_at, id) order — a stable partition, not a re-sort.
 *  Lead membership is a single batched `entity_categories` IN query over the whole
 *  widened list, never a per-task lookup. */
async function partitionLeadCandidates(owner: string, ids: string[], leadDimensions: string[]): Promise<string[]> {
  if (ids.length === 0 || leadDimensions.length === 0) return ids;
  const leadTagIds = await categoryIdsForOwner(leadDimensions, owner);
  if (leadTagIds.length === 0) return ids;

  const tagPlaceholders = leadTagIds.map(() => '?').join(',');
  const idPlaceholders = ids.map(() => '?').join(',');
  const rows = await store()
    .prepare(
      `SELECT DISTINCT entity_id AS id FROM entity_categories
        WHERE entity_kind = 'task' AND category_tag_id IN (${tagPlaceholders}) AND entity_id IN (${idPlaceholders})`
    )
    .all(...leadTagIds, ...ids) as { id: string }[];
  const leadIds = new Set(rows.map((r) => r.id));
  if (leadIds.size === 0) return ids;

  const leads: string[] = [];
  const rest: string[] = [];
  for (const id of ids) (leadIds.has(id) ? leads : rest).push(id);
  return [...leads, ...rest];
}

export async function fillFlightPlanCandidates(
  owner: string = currentOwnerId(),
  opts: { requireEstimate?: boolean; date?: string } = {},
): Promise<number> {
  const fillDate = opts.date ?? await ownerToday(owner);
  // TM-3: the auto-block path stages only estimate-bearing tasks (we won't fabricate a
  // block duration for a task the user never sized). Default false ⇒ unchanged staging.
  const estimateClause = opts.requireEstimate ? `AND estimated_minutes IS NOT NULL` : '';

  // bal-3: bias which dimensions get proposed, without ever excluding what the
  // original query would have staged (bounded by the same CANDIDATE_LIMIT slice).
  // Any failure anywhere in the bias path degrades to the exact original result —
  // a broken bias must not break staging.
  let candidateIds: string[];
  try {
    const leadDimensions = await biasLeadDimensionsForFill(owner, fillDate);
    if (leadDimensions.length === 0) {
      candidateIds = await openCandidateIds(owner, fillDate, estimateClause, CANDIDATE_LIMIT);
    } else {
      const widened = await openCandidateIds(owner, fillDate, estimateClause, CANDIDATE_LIMIT * WIDEN_FACTOR);
      candidateIds = (await partitionLeadCandidates(owner, widened, leadDimensions)).slice(0, CANDIDATE_LIMIT);
    }
  } catch (err) {
    logger.debug('fillFlightPlanCandidates: balance-bias path failed, falling back to unbiased fill', { err: (err as Error).message });
    candidateIds = await openCandidateIds(owner, fillDate, estimateClause, CANDIDATE_LIMIT);
  }

  const { m } = await store().prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get(owner) as { m: number };
  // Filled candidates arrive SELECTED (deselect-to-exclude model, req 8): manual
  // staging already inserts selected = 1, so both paths now align.
  const ins = store().prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`);
  let pos = m + 1;
  let added = 0;
  for (const id of candidateIds) if ((await ins.run(owner, id, pos++)).changes > 0) added++;
  return added;
}

/**
 * STEP 2: place SELECTED staged tasks. Plans first (tag-matched), then the
 * workday fallback if enabled. `blockId` scopes to a single Plan (legacy path).
 */
export async function placeFlightPlan(
  owner: string = currentOwnerId(),
  opts: {
    date?: string;
    blockId?: string;
    silent?: boolean;
    /** Reflow (auto-defense): re-place EXACTLY these tasks, in this order — the day's
     *  movable snapshot. Bypasses `flight_plan` (a reflow re-packs the board; it never
     *  reads or writes the user's staging area) and scopes the clear to the same set. */
    replaceTaskIds?: readonly string[];
    protectIds?: Set<string>;
    /** Injectable clock for the R3 clamp (tests); defaults to Date.now(). */
    nowMs?: number;
  } = {},
): Promise<AutoResult> {
  const date = opts.date ?? localISODate();
  const prefs = await prefsOf(owner);
  const tz = prefs?.timezone || serverTimezone();
  const staged = opts.replaceTaskIds ? await stagedFromTaskIds(owner, opts.replaceTaskIds) : await selectedStaged(owner, date);
  // R3: when placing on the owner-local CURRENT day, engine-chosen slots never start
  // before now — a re-pack fills the remaining day. Other days are untouched (a future
  // day has nothing to clamp; tests place on fixed past days deliberately).
  const nowMs = opts.nowMs ?? Date.now();
  const notBeforeMs = date === localDateInTZ(new Date(nowMs).toISOString(), tz) ? nowMs : null;
  const runId = newId(); // stamps every block this run creates, so Undo can target it (D2)

  // ── Legacy single-Plan scope: place tag-matched staged tasks into one Plan ──
  if (opts.blockId != null) {
    const block = await store().prepare(`SELECT start_at, end_at, tag FROM time_blocks WHERE id = ? AND owner_id = ?`).get(opts.blockId, owner) as
      | { start_at: string; end_at: string; tag: string | null }
      | undefined;
    if (!block) return { step: 'place', blocksCreated: 0, placed: 0, unplaced: staged.length };
    // Phase B (0135): the fill axis is the Plan's position-0 entity_categories row (the
    // retired category_id column is no longer consulted — 0135 backfilled it).
    const blockCategoryId = (await entityCategoryIds('time_block', opts.blockId))[0];
    let cands: StagedTask[];
    let ordered: StagedTask[];
    if (blockCategoryId) {
      // 0069 category Plan: fill ONLY its category candidates (NOT every staged task) —
      // the same secondary-tag + opt-out filter as the general Pass 1.5.
      cands = await categoryCandidates(staged, blockCategoryId, owner);
      ordered = cands; // preserve staged order (deterministic)
    } else {
      const catchAll = !!(await store()
        .prepare(`SELECT 1 FROM pattern_types WHERE name = ? AND catch_all = 1 LIMIT 1`)
        .get(block.tag) as {} | undefined);
      if (catchAll) {
        // Catch-all Plan: accept every staged task, sorted by priority only.
        cands = staged;
        ordered = [...staged].sort((a, b) => a.priority - b.priority || a.task_id.localeCompare(b.task_id));
      } else {
        // Phase 5: match on ANY of the Plan's tags; dilute secondaries in ordering.
        const weights = await planTagWeights(opts.blockId, block.tag);
        const planTags = [...weights.keys()];
        cands = planTags.length ? staged.filter((t) => planTags.some((name) => t.tags.includes(name))) : staged;
        ordered = orderForPlan(cands, weights);
      }
    }
    // Scoped clear (after cands are known): only the tasks this run will re-place into
    // the Plan lose their prior agent blocks — a staged task that doesn't match this
    // Plan keeps its existing placement.
    await clearPriorAutoInWindow(owner, Date.parse(block.start_at), Date.parse(block.end_at), cands.map((t) => t.task_id));
    const r = await placeIntoWindow(owner, ordered, Date.parse(block.start_at), Date.parse(block.end_at), prefs, { parentBlockId: opts.blockId, runId, notBeforeMs });
    await recordRun(owner, runId, r.blocksCreated);
    // A candidate whose block was cleared but found no room is back off the board.
    for (const t of cands) if (!r.placedTaskIds.has(t.task_id)) await revertTaskPlacementStatus(t.task_id, owner);
    if (!opts.silent) broadcast(owner, 'auto:placed', { blocksCreated: r.blocksCreated, placed: r.placedTaskIds.size, unplaced: cands.length - r.placedTaskIds.size });
    if (r.placedTaskIds.size > 0) {
      const del = store().prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`);
      for (const id of r.placedTaskIds) await del.run(owner, id);
      if (!opts.silent) broadcast(owner, 'flight_plan:updated', { removed: r.placedTaskIds.size });
    }
    return { step: 'place', blocksCreated: r.blocksCreated, placed: r.placedTaskIds.size, unplaced: cands.length - r.placedTaskIds.size, placedInPlans: r.placedTaskIds.size, placedInWorkday: 0 };
  }

  // ── General Auto: Plans first, then the workday fallback ────────────────────
  // Scoped to the tasks this run re-places (staged / replaceTaskIds): the clear set
  // and the re-place set are the same set by construction, so a run can never delete
  // a placement it isn't about to rebuild (the reflow-wipe bug, both paths).
  await clearPriorAuto(owner, date, tz, { taskIds: staged.map((t) => t.task_id), protectIds: opts.protectIds });
  const placedIds = new Set<string>();
  let blocksCreated = 0;

  // AD1 — pin task_time tasks first. A staged task that carries a wall-clock `task_time`
  // AND whose target day IS this placement date is honored EXACTLY at (date, task_time)
  // via the start-anchored path (its blocks are is_auto=0, so this run's clearPriorAuto
  // above — already done — won't touch them, and they become obstacles the packer flows
  // around). Such tasks are then excluded from every gap-packer pass below, so a 2pm task
  // never gets packed at 10am. Time-LESS staged tasks pack around the pins exactly as
  // before (no regression). Target day = scheduled_for (preferred) or due_at's local date.
  for (const t of staged) {
    if (!t.task_time) continue;
    const targetDay = t.scheduled_for ?? (t.due_at ? localDateInTZ(t.due_at, tz) : null);
    if (targetDay !== date) continue;
    // scheduled_for === date → placeStartAnchoredTask places at (scheduled_for, task_time)
    // exactly (with its nearest-gap-on-conflict + idempotency). When the day came only
    // from due_at (no scheduled_for), that path would misfire (it reads scheduled_for),
    // so pin inline at (date, task_time) with the same exact-or-nearest-gap semantics.
    // Count toward blocksCreated ONLY when a NEW block is made — both pin paths are
    // idempotent and return placed=true when reusing the task's existing active block,
    // which would otherwise inflate auto:placed.blocksCreated + recordRun bookkeeping.
    const hadBlock = !!await store()
      .prepare(
        `SELECT 1 FROM time_blocks
          WHERE task_id = ? AND owner_id = ? AND block_kind = 'task'
            AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL}) LIMIT 1`,
      )
      .get(t.task_id, owner);
    const pinned =
      t.scheduled_for === date
        ? (await placeStartAnchoredTask(owner, t.task_id, { silent: true, nowMs })).placed
        : await pinTaskAt(owner, t, date, tz, prefs, notBeforeMs);
    if (pinned) { placedIds.add(t.task_id); if (!hadBlock) blocksCreated++; }
  }

  // Pass 1 — fill each tagged Plan with its matching tasks. Tag-matched Plans run
  // first (so they get first pick of their candidates); catch-all Plans run last
  // and absorb whatever's left. Within each group, Plans run earliest-first.
  const allPlans = await dayPlans(owner, date, tz);
  const orderedPlans = [
    ...allPlans.filter((p) => !p.catch_all),
    ...allPlans.filter((p) => p.catch_all),
  ];
  for (const plan of orderedPlans) {
    let cands: StagedTask[];
    let ordered: StagedTask[];
    if (plan.catch_all) {
      // Catch-all Plan: accept every unplaced staged task, sorted by priority only.
      cands = staged.filter((t) => !placedIds.has(t.task_id));
      ordered = [...cands].sort((a, b) => a.priority - b.priority || a.task_id.localeCompare(b.task_id));
    } else {
      const weights = await planTagWeights(plan.id, plan.tag);
      const planTags = [...weights.keys()];
      cands = staged.filter((t) => !placedIds.has(t.task_id) && planTags.some((name) => t.tags.includes(name)));
      ordered = orderForPlan(cands, weights);
    }
    if (cands.length === 0) continue;
    const r = await placeIntoWindow(owner, ordered, Date.parse(plan.start_at), Date.parse(plan.end_at), prefs, { parentBlockId: plan.id, runId, notBeforeMs });
    r.placedTaskIds.forEach((id) => placedIds.add(id));
    blocksCreated += r.blocksCreated;
  }

  // Pass 1.5 — category Plans (0069). Disjoint from Pass 1 (dayPlans excludes rows with a
  // category_id; dayCategoryPlans requires one — see dayCategoryPlans doc), so no
  // block is filled twice. Each is filled with its category candidates (secondary-tag
  // match + direction opt-out filter), preserving staged order. Runs immediately after
  // Pass 1 and before the direction-window pass, so category blocks supersede pattern
  // windows for their span (via dayObstacles includePlans) just like tag-Plans.
  for (const plan of await dayCategoryPlans(owner, date, tz)) {
    const filtered = (await categoryCandidates(staged, plan.category_id, owner)).filter((t) => !placedIds.has(t.task_id));
    if (filtered.length === 0) continue;
    const r = await placeIntoWindow(owner, filtered, Date.parse(plan.start_at), Date.parse(plan.end_at), prefs, { parentBlockId: plan.id, runId, notBeforeMs });
    r.placedTaskIds.forEach((id) => placedIds.add(id));
    blocksCreated += r.blocksCreated;
  }
  const placedInPlans = placedIds.size;

  // Pass 1.75 — Phase M A4 NL tag-window hints (transient per-tag clock windows). Runs
  // after the explicit Plan passes (those still win) but BEFORE direction windows, so a
  // same-day instruction outranks a recurring pattern. `hintConstrainedIds` is excluded
  // from the direction-window pass AND the workday fill below, so a hinted task never
  // lands outside its window (HARD: a full/empty window leaves it unplaced). Reflow honours
  // this automatically — it re-runs placeFlightPlan, which re-reads `plan_hints`.
  const hintPass = await placeHintWindows(owner, date, staged.filter((s) => !placedIds.has(s.task_id)), prefs, tz, runId, notBeforeMs);
  hintPass.placedTaskIds.forEach((id) => placedIds.add(id));
  blocksCreated += hintPass.blocksCreated;
  const hintConstrainedIds = hintPass.constrainedIds;

  // Pass 1.9 — L02-first. A task with a matching Time Block belongs in it, not in the
  // bare L01 window the block sits inside ("matching Time Block with room first, then
  // L01 windows"). Runs after the hint pass so a same-day NL instruction still wins,
  // and before the direction windows so a container outranks a pattern window.
  const containerPass = await placeIntoContainers(
    owner,
    date,
    staged.filter((s) => !placedIds.has(s.task_id) && !hintConstrainedIds.has(s.task_id)),
    prefs,
    tz,
    runId,
    notBeforeMs,
  );
  containerPass.placedTaskIds.forEach((id) => placedIds.add(id));
  blocksCreated += containerPass.blocksCreated;

  // Pass 2a — direction-window placement (tag-matched). Runs UNCONDITIONALLY: this is
  // part of tag-matched placement (tap 2), not the priority fill. Direction-tagged
  // tasks are constrained to their direction's pattern windows (union, earliest-first),
  // flowing around the Plans. Per-direction auto_fill (pattern_prefs) is still honored.
  // Leftover capacity is left OPEN here — the workday/priority fill is the separate,
  // explicit fillByPriority() step (tap 3, D5).
  const dayType = await resolveDayType(owner, date);
  const patWindows = await getPatternBlocks(owner, dayType);
  // Track tasks gated off by per-direction auto_fill=false so Pass 2b skips them too.
  const directionGatedOffIds = new Set<string>();
  if (Object.keys(patWindows).length > 0) {
    const dprefs = await getPatternPrefs(owner);
    const dirNameToId = new Map<string, string>(); // direction tag name → id
    const ids = Object.keys(patWindows);
    const dirTags = await store()
      .prepare(`SELECT id, name FROM tags WHERE owner_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND kind = 'direction'`)
      .all(owner, ...ids) as { id: string; name: string }[];
    for (const dt of dirTags) dirNameToId.set(dt.name, dt.id);

    for (const t of staged.filter((s) => !placedIds.has(s.task_id) && !hintConstrainedIds.has(s.task_id))) {
      const taskDirIds = t.tags
        .map((name) => dirNameToId.get(name))
        .filter((id): id is string => id !== undefined);
      if (taskDirIds.length === 0) continue;
      const enabledDirIds = taskDirIds.filter((dirId) => dprefs[dirId]?.auto_fill ?? true);
      if (enabledDirIds.length === 0) { directionGatedOffIds.add(t.task_id); continue; }
      const allRanges = enabledDirIds
        .flatMap((did) => patWindows[did] ?? [])
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      for (const range of allRanges) {
        if (placedIds.has(t.task_id)) break;
        const winStart = Date.parse(zonedWallTimeToUTC(date, range.start_time, tz));
        const winEnd = Date.parse(zonedWallTimeToUTC(date, range.end_time, tz));
        const r = await placeIntoWindow(owner, [t], winStart, winEnd, prefs, { parentBlockId: null, includePlans: true, runId, notBeforeMs });
        r.placedTaskIds.forEach((id) => placedIds.add(id));
        blocksCreated += r.blocksCreated;
      }
    }
  }

  // Pass 2b — workday fallback fill (gated by auto_fill_workday; ordered by fill_order).
  // Runs inside placeFlightPlan so it shares the same runId (Undo reverts everything).
  // Skips tasks that have a direction tag with auto_fill=false (directionGatedOffIds).
  let placedInWorkday = 0;
  if ((prefs?.auto_fill_workday ?? 1) === 1) {
    const remaining = staged.filter((t) => !placedIds.has(t.task_id) && !directionGatedOffIds.has(t.task_id) && !hintConstrainedIds.has(t.task_id));
    if (remaining.length > 0) {
      // When a daily_plan has been authored for today, it already encodes the
      // preferred sequence (LLM or deterministic) — preserve that order so placement
      // faithfully executes what authoring decided. Without a daily_plan, fall back
      // to the fill_order pref (pre-Phase-M backward-compatible behaviour).
      const hasDailyPlan = !!(await store()
        .prepare(`SELECT 1 FROM daily_plan WHERE owner_id = ? AND date = ? LIMIT 1`)
        .get(owner, date));
      const fillOrder = prefs?.fill_order ?? 'priority';
      const ordered = hasDailyPlan
        ? remaining // selectedStaged already ordered by daily_plan.position
        : fillOrder === 'overdue' ? orderByOverdue(remaining)
        // 'new_today': today's arrivals take the earliest slots (see orderByNewToday).
        // Keyed on the owner's real today, not `date`, so planning ahead still honors it.
        : fillOrder === 'new_today' ? orderByNewToday(remaining, await ownerToday(owner), tz)
        : orderForPlan(remaining);
      // 0156: the fallback-fill union (work+community pattern_blocks) replaces the
      // flat workday_start/workday_end window. Placed range-by-range (not collapsed
      // to one min/max span) so a gap between two configured windows is honored;
      // each range only gets tasks the previous range didn't already place.
      for (const range of await directionWindowsMs(owner, dayType, date, tz, FALLBACK_FILL_DIRECTION_NAMES)) {
        const stillOpen = ordered.filter((t) => !placedIds.has(t.task_id));
        if (stillOpen.length === 0) break;
        const r = await placeIntoWindow(owner, stillOpen, range.start, range.end, prefs, { parentBlockId: null, includePlans: true, runId, notBeforeMs });
        r.placedTaskIds.forEach((id) => placedIds.add(id));
        blocksCreated += r.blocksCreated;
        placedInWorkday += r.placedTaskIds.size;
      }
    }
  }

  await recordRun(owner, runId, blocksCreated);

  // R2: a staged task whose prior block was cleared but that found no room is off the
  // board again — return it to the open backlog (scheduled ⇒ open; no-op otherwise).
  for (const t of staged) if (!placedIds.has(t.task_id)) await revertTaskPlacementStatus(t.task_id, owner);

  // Link block_id in daily_plan for every placed task (Phase M §0 / A3: the block
  // detail view joins daily_plan on block_id to display the per-task rationale).
  if (placedIds.size > 0) {
    const linkBlk = store().prepare(
      `UPDATE daily_plan
          SET block_id = (
            SELECT id FROM time_blocks
             WHERE task_id = ? AND owner_id = ? AND is_auto = 1 AND auto_run_id = ? AND block_kind = 'task'
             ORDER BY start_at LIMIT 1
          )
        WHERE owner_id = ? AND date = ? AND task_id = ?`
    );
    for (const taskId of placedIds) await linkBlk.run(taskId, owner, runId, owner, date, taskId);
  }

  const placed = placedIds.size;
  const unplaced = staged.length - placed;
  // A container placement IS a placement into a Plan — the L02-first pass just gets
  // there by the nest rule rather than by the Plan passes' narrower candidate queries.
  const placedInContainers = containerPass.placedTaskIds.size;
  if (!opts.silent) broadcast(owner, 'auto:placed', { blocksCreated, placed, unplaced });
  if (placedIds.size > 0) {
    const del = store().prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`);
    for (const id of placedIds) await del.run(owner, id);
    if (!opts.silent) broadcast(owner, 'flight_plan:updated', { removed: placedIds.size });
  }
  return { step: 'place', blocksCreated, placed, unplaced, placedInPlans: placedInPlans + placedInContainers, placedInWorkday };
}

/**
 * The explicit priority top-up (tap 3, D5). Tag-matched placement (placeFlightPlan)
 * leaves leftover capacity OPEN; this fills the workday window with the highest-
 * priority still-unplaced selected tasks (P1 first), flowing around everything already
 * placed (Plans, meetings, prior auto/manual blocks). Never auto-runs — it is always an
 * explicit tap, in both modes. Gated by the `auto_fill_workday` pref (off → no-op).
 */
export async function fillByPriority(owner: string = currentOwnerId(), opts: { date?: string; nowMs?: number } = {}): Promise<AutoResult> {
  const date = opts.date ?? localISODate();
  const prefs = await prefsOf(owner);
  const tz = prefs?.timezone || serverTimezone();
  // R3 clamp (see placeFlightPlan): today's engine-chosen slots start no earlier than now.
  const nowMs = opts.nowMs ?? Date.now();
  const notBeforeMs = date === localDateInTZ(new Date(nowMs).toISOString(), tz) ? nowMs : null;
  if ((prefs?.auto_fill_workday ?? 1) !== 1) {
    return { step: 'place', blocksCreated: 0, placed: 0, unplaced: 0, placedInPlans: 0, placedInWorkday: 0 };
  }

  const staged = await selectedStaged(owner, date);
  // Tasks already auto-placed today are not re-placed (this top-up runs AFTER tap 2,
  // and must not clear or duplicate those placements).
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  const placedTaskIds = new Set(
    (await store()
      .prepare(
        `SELECT DISTINCT task_id FROM time_blocks
          WHERE owner_id = ? AND ${AUTO_PLACED_SQL} AND task_id IS NOT NULL
            AND start_at < ? AND end_at > ?`,
      )
      .all(owner, dayEndISO, dayStartISO) as { task_id: string }[]).map((r) => r.task_id),
  );
  const remaining = staged.filter((t) => !placedTaskIds.has(t.task_id));
  if (remaining.length === 0) {
    return { step: 'place', blocksCreated: 0, placed: 0, unplaced: 0, placedInPlans: 0, placedInWorkday: 0 };
  }

  // orderForPlan with no weights sorts priority-first (P1 first). includePlans flows
  // around Plans and the tag-matched blocks tap 2 already created.
  const runId = newId();
  // A4: honour NL tag-window hints here too. A hint-constrained task is placed only within
  // its window (or left unplaced) and excluded from the unconstrained priority fill, so the
  // explicit top-up can't leak "no errands before noon" past its window.
  const hintPass = await placeHintWindows(owner, date, remaining, prefs, tz, runId, notBeforeMs);
  const unconstrained = orderForPlan(remaining.filter((t) => !hintPass.constrainedIds.has(t.task_id)));
  // 0156: fallback-fill union (work+community pattern_blocks) replaces the flat
  // workday_start/workday_end window — same range-by-range placement as Pass 2b.
  const dayType = await resolveDayType(owner, date);
  const placedByFill = new Set<string>();
  let fillBlocksCreated = 0;
  for (const range of await directionWindowsMs(owner, dayType, date, tz, FALLBACK_FILL_DIRECTION_NAMES)) {
    const stillOpen = unconstrained.filter((t) => !placedByFill.has(t.task_id));
    if (stillOpen.length === 0) break;
    const r = await placeIntoWindow(owner, stillOpen, range.start, range.end, prefs, { parentBlockId: null, includePlans: true, runId, notBeforeMs });
    r.placedTaskIds.forEach((id) => placedByFill.add(id));
    fillBlocksCreated += r.blocksCreated;
  }
  const filled = new Set([...hintPass.placedTaskIds, ...placedByFill]);
  const blocksCreated = hintPass.blocksCreated + fillBlocksCreated;
  await recordRun(owner, runId, blocksCreated);
  const placed = filled.size;
  broadcast(owner, 'auto:placed', { blocksCreated, placed, unplaced: remaining.length - placed });
  if (filled.size > 0) {
    const del = await store().prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`);
    for (const id of filled) await del.run(owner, id);
    broadcast(owner, 'flight_plan:updated', { removed: filled.size });
  }
  return { step: 'place', blocksCreated, placed, unplaced: remaining.length - placed, placedInPlans: 0, placedInWorkday: placed };
}

/**
 * Is there a placement run the owner could still undo right now?
 *
 * Deliberately checks for surviving BLOCKS, not just the `last_auto_run_id` pointer: the
 * pointer outlives its blocks whenever something else deletes them (Clear Date Range, a
 * manual block delete, a reflow), and a button offered on a dangling pointer would answer
 * "Nothing to undo" — an affordance that lies. Cheap enough to ride every flight-plan read.
 */
export async function canUndoLastAuto(owner: string = currentOwnerId()): Promise<boolean> {
  return !!await store()
    .prepare(
      `SELECT 1 FROM time_blocks b JOIN owners o ON o.id = b.owner_id
        WHERE b.owner_id = ? AND b.auto_run_id IS NOT NULL AND b.auto_run_id = o.last_auto_run_id
        LIMIT 1`,
    )
    .get(owner);
}

/**
 * Undo the LAST placement run (D2 — single-step, no stack). Deletes only the blocks
 * stamped with the owner's most recent run_id (never manual or meeting blocks, which
 * carry no auto_run_id), re-stages those tasks onto the flight-plan (selected), and
 * clears the pointer so a second undo is a no-op. Returns the counts.
 */
export async function undoLastAuto(owner: string = currentOwnerId()): Promise<{ removed: number; restaged: number }> {
  const runId = (await store().prepare(`SELECT last_auto_run_id FROM owners WHERE id = ?`).get(owner) as { last_auto_run_id: string | null } | undefined)?.last_auto_run_id;
  if (!runId) return { removed: 0, restaged: 0 };

  // The tasks this run placed (re-stage them so the user can re-place/adjust).
  const taskIds = (await store().prepare(`SELECT DISTINCT task_id FROM time_blocks WHERE auto_run_id = ? AND owner_id = ? AND task_id IS NOT NULL`).all(runId, owner) as { task_id: string }[]).map((r) => r.task_id);

  const removed = (await store().prepare(`DELETE FROM time_blocks WHERE auto_run_id = ? AND owner_id = ?`).run(runId, owner)).changes;

  let pos = (await store().prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get(owner) as { m: number }).m + 1;
  const insFp = store().prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`);
  const selFp = store().prepare(`UPDATE flight_plan SET selected = 1 WHERE owner_id = ? AND task_id = ?`);
  let restaged = 0;
  for (const taskId of taskIds) {
    if ((await insFp.run(owner, taskId, pos)).changes > 0) pos++;
    else await selFp.run(owner, taskId); // already staged → just re-select it
    restaged++;
  }

  await store().prepare(`UPDATE owners SET last_auto_run_id = NULL WHERE id = ?`).run(owner); // single-step undo
  broadcast(owner, 'auto:undone', { removed, restaged });
  return { removed, restaged };
}

/** Clear prior agent placements overlapping a specific window (the single-Plan path).
 *  Scoped to `taskIds` — only the tasks this run re-places into the Plan (same
 *  clear-set == re-place-set rule as clearPriorAuto). */
async function clearPriorAutoInWindow(owner: string, windowStartMs: number, windowEndMs: number, taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) return;
  await store()
    .prepare(
      `DELETE FROM time_blocks
        WHERE owner_id = ? AND ${REFLOW_CANDIDATE_SQL}
          AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
          AND task_id IN (${taskIds.map(() => '?').join(',')})
          AND start_at < ? AND end_at > ?`
    )
    .run(owner, ...taskIds, new Date(windowEndMs).toISOString(), new Date(windowStartMs).toISOString());
}

/**
 * Legacy combined entry point — retained for any callers that haven't migrated
 * to the explicit fill/place split. The UI now calls fillFlightPlanCandidates
 * and placeFlightPlan directly through separate endpoints.
 */
export async function runAuto(opts: { date?: string; blockId?: string } = {}): Promise<AutoResult> {
  const owner = currentOwnerId();
  if (await flightPlanCount(owner) === 0) {
    const added = await fillFlightPlanCandidates(owner);
    broadcast(owner, 'flight_plan:filled', { added });
    return { step: 'fill', candidatesAdded: added };
  }
  return await placeFlightPlan(owner, opts);
}

export type TrustMode = 'cautious' | 'balanced' | 'hands_off';

export interface TrustPolicy {
  mode: TrustMode;
  /** auto-block promoted, estimate-bearing Tasks at the promotion boundary (Hands-off only). */
  autoBlock: boolean;
}

/**
 * The owner's trust dial (TM-2; FTUE gaps 5 & 6) — the single source of truth that maps
 * `scheduling_prefs.trust_mode` to behavior. Read this, never the raw column. Defaults to
 * the safe 'balanced' when prefs are absent (auto-block off — today's behavior).
 *
 * AF-3 retired the dial's auto-PROMOTE facet (the old `autoPromote`/`promoteThreshold`
 * fields): every possible_task is now promoted unconditionally at ingestion
 * (services/possibles.ts promoteAllPending) and by the nightly sweeper (agents/groom.ts).
 * trust_mode governs ONLY auto-blocking/planning — 'cautious'/'balanced' leave placement
 * to the user; 'hands_off' auto-blocks (and agents/plan.ts maps hands_off → smart).
 */
export async function resolveTrustPolicy(owner: string = currentOwnerId()): Promise<TrustPolicy> {
  const row = await store().prepare(`SELECT trust_mode FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as
    | { trust_mode?: string }
    | undefined;
  const mode: TrustMode = row?.trust_mode === 'cautious' || row?.trust_mode === 'hands_off' ? row.trust_mode : 'balanced';
  return {
    mode,
    autoBlock: mode === 'hands_off',
  };
}

/**
 * Hands-off zero-click path (TM-4): collapse taps 1+2 — fill candidates (all selected) and
 * place tag-matched work in one pass. No-op unless the trust dial is Hands-off (Cautious /
 * Balanced leave the user to drive the taps). The explicit priority top-up (tap 3) is never
 * silent and is NOT run here. `requireEstimate` limits staging to estimate-bearing tasks (the
 * promotion-boundary policy, TM-5). Returns the place result, or null when off / nothing to do.
 */
export async function autoScheduleOnIngest(
  owner: string = currentOwnerId(),
  opts: { date?: string; requireEstimate?: boolean } = {},
): Promise<AutoResult | null> {
  if (!(await resolveTrustPolicy(owner)).autoBlock) return null;
  const date = opts.date ?? await ownerToday(owner);
  await fillFlightPlanCandidates(owner, { requireEstimate: opts.requireEstimate, date }); // stage new open tasks, all selected
  if ((await selectedStaged(owner, date)).length === 0) return null;
  // Place the SAME day we filled — passing the resolved `date` (not raw opts.date) keeps
  // fill and placement on one owner-local day when the caller omitted a date.
  return await placeFlightPlan(owner, { date });
}

// ─── Phase AB · AB1 — start-anchored placement ─────────────────────────────────

export type StartAnchoredOutcome =
  | { placed: true; blockId: string; startAt: string; endAt: string }
  | { placed: false; reason: 'not_found' | 'no_start' | 'day_full' };

/**
 * Blocks created by start-anchored placement are engine-written but USER-intended
 * (`scheduled_for`/`task_time` came from the wizard or an accepted suggestion), so
 * they are `is_auto = 0`: `clearPriorAuto` — which wipes `is_auto = 1` agent blocks
 * at the start of every Auto run — must never delete a stated start time. They keep
 * `source_kind = 'agent'` for provenance and carry no `auto_run_id` (honoring intent
 * is not an undoable engine run).
 */
const insAnchoredBlock = () =>
  store().prepare(
    `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status)
     VALUES (uuid7(), ?, ?, ?, 'task', ?, ?, 0, 0, 'agent', 'planned') RETURNING id`,
  );

/**
 * AB1 — place a task exactly where its START intent says (the spec's
 * `placeStartAnchoredTask`). NOT trust-gated: the user (or an accepted suggestion)
 * stated the day/time, so honoring it is not engine autonomy — the trust dial keeps
 * gating engine-CHOSEN placement only (autoScheduleOnIngest, start-less tasks).
 *
 *  - `task_time` set → one block exactly at (scheduled_for, task_time), duration =
 *    estimated_minutes (fallback: the default_time_block_minutes pref, 60). If that
 *    exact span overlaps an active block (locked / meeting / open task block — Plan
 *    containers don't count; a stated time inside a Plan is fine), fall back to the
 *    open gap NEAREST the requested time on the SAME local day.
 *  - no `task_time` → the engine picks the time on THAT date: earliest fit inside the
 *    task's direction windows for the date's day-type (pass-2a semantics, incl. the
 *    per-direction auto_fill gate), else the earliest open workday gap on that date.
 *  - Works for any future date. Returns the block or `{ placed:false, 'day_full' }`.
 *
 * due_at plays no role here — it is a deadline, never a placement-day selector.
 */
export async function placeStartAnchoredTask(
  owner: string,
  taskId: string,
  opts: { silent?: boolean; nowMs?: number } = {},
): Promise<StartAnchoredOutcome> {
  const task = await store()
    .prepare(`SELECT id, title, scheduled_for, task_time, estimated_minutes FROM tasks WHERE id = ? AND owner_id = ?`)
    .get(taskId, owner) as
    | { id: string; title: string; scheduled_for: string | null; task_time: string | null; estimated_minutes: number | null }
    | undefined;
  if (!task) return { placed: false, reason: 'not_found' };
  if (!task.scheduled_for) return { placed: false, reason: 'no_start' };

  const prefs = await prefsOf(owner);
  const tz = prefs?.timezone || serverTimezone();
  const date = task.scheduled_for;

  // H4 idempotency: honour a block already on the STATED day (or a locked pin anywhere)
  // as the placement; a stale unlocked block on another day is cleared so the stated
  // day wins (pre-H4 this treated ANY active block as placed, so a leftover block on the
  // wrong/past day meant the stated day was silently never honoured). These blocks are
  // is_auto=0, so clearPriorAuto never sweeps them — this is the sole dedup guard.
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  const existing = await reconcilePriorPlacement(owner, taskId, dayStartISO, dayEndISO);
  if (existing) {
    await store().prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`).run(owner, taskId);
    await applyTaskPlacementStatus(taskId, owner); // R2 parity: the existing block IS the placement
    return { placed: true, blockId: existing.id, startAt: existing.start_at, endAt: existing.end_at };
  }

  // R3 clamp: on the owner-local current day, ENGINE-CHOSEN slots (direction-window /
  // workday fits and the nearest-gap fallback) start no earlier than now. The user's
  // exact (scheduled_for, task_time) instant is exempt — stated intent is honored even
  // in the past.
  const nowMs = opts.nowMs ?? Date.now();
  const notBeforeMs = date === localDateInTZ(new Date(nowMs).toISOString(), tz) ? nowMs : null;
  const durMs = Math.max((task.estimated_minutes ?? prefs?.default_time_block_minutes ?? 60) * MS_PER_MIN, MIN_SESSION_MS);
  const breakMs = (prefs?.min_break_minutes ?? 10) * MS_PER_MIN;

  const create = async (startMs: number, endMs: number): Promise<StartAnchoredOutcome> => {
    const startAt = new Date(startMs).toISOString();
    const endAt = new Date(endMs).toISOString();
    const { id: blockId } = await insAnchoredBlock().get(task.id, owner, task.title, startAt, endAt) as { id: string };
    // A staged copy of this task must not be auto-placed AGAIN by the next Auto run.
    await store().prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`).run(owner, task.id);
    await applyTaskPlacementStatus(task.id, owner); // R2 parity: placed = scheduled
    if (!opts.silent) broadcast(owner, 'auto:placed', { blocksCreated: 1, placed: 1, unplaced: 0 });
    return { placed: true, blockId, startAt, endAt };
  };

  /** Earliest gap fitting the full duration inside [winStart, winEnd], flowing around Plans. */
  const earliestFit = async (winStartMs: number, winEndMs: number): Promise<number | null> => {
    if (notBeforeMs != null) winStartMs = Math.max(winStartMs, notBeforeMs);
    if (winEndMs - winStartMs < durMs) return null;
    const fixed = await dayObstacles(owner, winStartMs, winEndMs, { includePlans: true });
    for (const g of buildGaps(winStartMs, winEndMs, fixed, breakMs)) {
      if (g.end - g.cursor >= durMs) return g.cursor;
    }
    return null;
  };

  if (task.task_time) {
    // Exact-time placement. Plan containers are NOT obstacles here — the user picked
    // this time; a block inside a Plan's span is normal grouping, not double-booking.
    const startMs = Date.parse(zonedWallTimeToUTC(date, task.task_time, tz));
    const endMs = startMs + durMs;
    if ((await dayObstacles(owner, startMs, endMs)).length === 0) return await create(startMs, endMs);

    // Occupied → the open gap NEAREST the requested time on the SAME local day
    // (engine-chosen, so the R3 clamp applies).
    const bounds = utcDayBounds(date, tz);
    const dayStart = Math.max(Date.parse(bounds.start), notBeforeMs ?? Number.NEGATIVE_INFINITY);
    const dayEnd = Date.parse(bounds.end);
    const gaps = buildGaps(dayStart, dayEnd, await dayObstacles(owner, dayStart, dayEnd), breakMs);
    let bestStart: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const g of gaps) {
      if (g.end - g.cursor < durMs) continue;
      const s = Math.min(Math.max(startMs, g.cursor), g.end - durMs); // closest in-gap start to the request
      const dist = Math.abs(s - startMs);
      if (dist < bestDist) { bestStart = s; bestDist = dist; }
    }
    if (bestStart === null) return { placed: false, reason: 'day_full' };
    return await create(bestStart, bestStart + durMs);
  }

  // No task_time → direction-window placement for THAT date (pass-2a semantics):
  // the task's level-1 direction tags, minus those gated off by auto_fill=false,
  // union of their windows for the date's day-type, earliest-first.
  const dayType = await resolveDayType(owner, date);
  const patWindows = await getPatternBlocks(owner, dayType);
  if (Object.keys(patWindows).length > 0) {
    const dprefs = await getPatternPrefs(owner);
    const dirIds = (
      await store()
        .prepare(
          `SELECT DISTINCT tg.id FROM entity_tags et
             JOIN tags tg ON tg.id = et.tag_id
            WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1
              AND tg.kind = 'direction' AND tg.owner_id = ?`,
        )
        .all(task.id, owner) as { id: string }[]
    ).map((r) => r.id);
    const ranges = dirIds
      .filter((dirId) => dprefs[dirId]?.auto_fill ?? true)
      .flatMap((dirId) => patWindows[dirId] ?? [])
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
    for (const range of ranges) {
      const s = await earliestFit(
        Date.parse(zonedWallTimeToUTC(date, range.start_time, tz)),
        Date.parse(zonedWallTimeToUTC(date, range.end_time, tz)),
      );
      if (s !== null) return create(s, s + durMs);
    }
  }

  // 0156: fallback-fill union (work+community pattern_blocks) on that date, replacing
  // the flat workday_start/workday_end window — same shared helper as Pass 2b.
  for (const range of await directionWindowsMs(owner, dayType, date, tz, FALLBACK_FILL_DIRECTION_NAMES)) {
    const s = await earliestFit(range.start, range.end);
    if (s !== null) return create(s, s + durMs);
  }
  return { placed: false, reason: 'day_full' };
}
