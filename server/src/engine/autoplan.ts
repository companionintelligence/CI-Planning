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
 *      2. **Workday fallback** (secondary, gated by `auto_fill_workday`). Anything
 *         still unplaced fills open workday time, flowing *around* the Plans.
 *
 * Both passes schedule around the shared `dayObstacles` set, so nothing stacks
 * on existing work (manual or auto) and manually-placed blocks survive re-runs.
 * A single `blockId` still scopes placement to one Plan (the "Auto into this
 * Plan" affordance).
 */
import { sqlite } from '../db/index.js';
import { broadcast } from '../routes/sse.js';
import { serverTimezone, zonedWallTimeToUTC, utcDayBounds } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { taskTagNames } from '../services/tags.js';
import { localISODate } from '../lib/dates.js';
import { newId } from '../lib/ids.js';
import { buildGaps, pickGap, splitIntoSessions, dayObstacles, MS_PER_MIN } from './scheduler.js';
import { entityTagLevels, splitTagString } from '../services/tags.js';
import { getPatternBlocks } from '../services/pattern-blocks.js';
import { resolveDayType } from '../services/day-types.js';
import { getPatternPrefs } from '../services/pattern-prefs.js';

const DEFAULT_EST_MIN = 30;
const MIN_SESSION_MS = 15 * MS_PER_MIN;
const CANDIDATE_LIMIT = 20;

export interface AutoResult {
  step: 'fill' | 'place';
  candidatesAdded?: number;
  blocksCreated?: number;
  placed?: number;
  unplaced?: number;
  placedInPlans?: number;    // step 2: tasks that landed inside a Plan
  placedInWorkday?: number;  // step 2: tasks that landed in the workday fallback
  days?: number;             // T-SCHED-2: how many days a Schedule-mode horizon run spanned (>1 only)
}

interface StagedTask {
  task_id: string;
  title: string;
  estimated_minutes: number | null;
  priority: number;
  due_at: string | null;
  tags: string[];
}
interface PrefsRow {
  timezone: string | null;
  workday_start: string | null;
  workday_end: string | null;
  min_break_minutes: number | null;
  max_focus_block_minutes: number | null;
  auto_fill_workday: number | null;
  fill_order: string | null;
}
interface PlanRow {
  id: string;
  start_at: string;
  end_at: string;
  tag: string | null;
  catch_all: number;
}

function tagsOf(taskId: string): string[] {
  return taskTagNames(taskId);
}

/**
 * Selected staged tasks, ordered by `daily_plan.position` when an authored day plan
 * exists for `date` (Phase M §0 / A1). Tasks with no `daily_plan` row (e.g. added
 * after authoring) fall through to the original `fp.position` ordering so nothing
 * is ever silently dropped.
 */
function selectedStaged(owner: string, date: string): StagedTask[] {
  const rows = sqlite
    .prepare(
      `SELECT fp.task_id, t.title, t.estimated_minutes, t.priority, t.due_at
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
  return rows.map((r) => ({ ...r, priority: r.priority ?? 3, tags: tagsOf(r.task_id) }));
}

/** How many tasks are staged in the flight-plan (selected or not). */
function flightPlanCount(owner: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ?`).get(owner) as { n: number }).n;
}

/** Record the most recent placement run for the owner, so Undo can target it (D2). */
function recordRun(owner: string, runId: string, blocksCreated: number): void {
  if (blocksCreated > 0) sqlite.prepare(`UPDATE owners SET last_auto_run_id = ? WHERE id = ?`).run(runId, owner);
}

function prefsOf(owner: string): PrefsRow | undefined {
  return sqlite
    .prepare(`SELECT timezone, workday_start, workday_end, min_break_minutes, max_focus_block_minutes, auto_fill_workday, fill_order FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as PrefsRow | undefined;
}

/** Tagged, timed Plan containers on `date`, earliest first. */
function dayPlans(date: string, tz: string): PlanRow[] {
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  return sqlite
    .prepare(
      `SELECT tb.id, tb.start_at, tb.end_at, tb.tag,
              COALESCE((SELECT pt.catch_all FROM pattern_types pt
                         WHERE pt.name = tb.tag AND pt.catch_all = 1 LIMIT 1), 0) AS catch_all
         FROM time_blocks tb
        WHERE tb.block_kind = 'timeblock' AND tb.block_type = 'scheduled' AND tb.tag IS NOT NULL
          AND tb.category_id IS NULL
          AND COALESCE(tb.all_day, 0) = 0
          AND tb.start_at < ? AND tb.end_at > ?
        ORDER BY tb.start_at, tb.id`
    )
    .all(dayEndISO, dayStartISO) as PlanRow[];
}

interface CategoryPlanRow { id: string; start_at: string; end_at: string; category_id: string }

/**
 * Category-tagged, timed Plan containers on `date`, earliest first (0069). Disjoint
 * from dayPlans by the tag XOR category_id invariant (a category container has tag
 * NULL; a tag-Plan has category_id NULL — enforced in routes/blocks.ts), so no block
 * is ever filled by both passes.
 */
function dayCategoryPlans(date: string, tz: string): CategoryPlanRow[] {
  const dayStartISO = zonedWallTimeToUTC(date, '00:00', tz);
  const dayEndISO = new Date(Date.parse(dayStartISO) + 24 * 60 * 60_000).toISOString();
  return sqlite
    .prepare(
      `SELECT tb.id, tb.start_at, tb.end_at, tb.category_id
         FROM time_blocks tb
        WHERE tb.block_kind = 'timeblock' AND tb.block_type = 'scheduled' AND tb.category_id IS NOT NULL
          AND COALESCE(tb.all_day, 0) = 0
          AND tb.start_at < ? AND tb.end_at > ?
        ORDER BY tb.start_at, tb.id`
    )
    .all(dayEndISO, dayStartISO) as CategoryPlanRow[];
}

/**
 * Staged tasks eligible for a category Plan (0069): a SECONDARY tag (entity_tags
 * level>1) that is a member of the category, AND a direction that is NOT fully opted
 * out for the category. Preserves `staged` order (deterministic — id-keyed, no clock/
 * randomness). NB: `staged.tags` is level-1 only, so category matching MUST read
 * entity_tags level>1 directly. A direction-less task is included on the tag match alone.
 */
function categoryCandidates(staged: StagedTask[], categoryId: string): StagedTask[] {
  const candIds = new Set(
    (sqlite
      .prepare(
        `SELECT DISTINCT entity_id FROM entity_tags
          WHERE entity_kind = 'task' AND level > 1
            AND tag_id IN (SELECT intention_tag_id FROM tag_categories WHERE category_tag_id = ?)`
      )
      .all(categoryId) as { entity_id: string }[]).map((r) => r.entity_id),
  );
  if (candIds.size === 0) return [];
  const optOut = new Set(
    (sqlite
      .prepare(`SELECT pattern_tag_id FROM category_direction_optouts WHERE category_tag_id = ?`)
      .all(categoryId) as { pattern_tag_id: string }[]).map((r) => r.pattern_tag_id),
  );
  const patNameToId = new Map<string, string>();
  for (const pt of sqlite.prepare(`SELECT id, name FROM tags WHERE kind = 'pattern'`).all() as { id: string; name: string }[]) {
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
function planTagWeights(planId: string, fallbackTag: string | null): Map<string, number> {
  const levels = entityTagLevels('time_block', planId);
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

const insBlock = () =>
  sqlite.prepare(
    `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, parent_block_id, auto_run_id)
     VALUES (uuid7(), ?, ?, 'task', ?, ?, 0, 1, 'agent', 'planned', ?, ?)`
  );

/** Clear our OWN prior agent placements for the local day (pattern blocks survive). */
function clearPriorAuto(date: string, tz: string): void {
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  sqlite
    .prepare(
      `DELETE FROM time_blocks
        WHERE is_auto = 1 AND is_locked = 0 AND block_kind = 'task' AND source_kind = 'agent'
          AND status NOT IN ('completed','skipped')
          AND start_at < ? AND end_at > ?`
    )
    .run(dayEndISO, dayStartISO);
}

/**
 * Place `tasks` (in the order given) into [windowStartMs, windowEndMs], around
 * the live obstacle set. Returns the task ids that got at least one session.
 * Does not clear — the caller owns idempotent clearing for the whole run.
 */
function placeIntoWindow(
  tasks: StagedTask[],
  windowStartMs: number,
  windowEndMs: number,
  prefs: PrefsRow | undefined,
  opts: { parentBlockId?: string | null; includePlans?: boolean; runId?: string | null }
): { blocksCreated: number; placedTaskIds: Set<string> } {
  const placedTaskIds = new Set<string>();
  if (windowEndMs <= windowStartMs || tasks.length === 0) return { blocksCreated: 0, placedTaskIds };

  const breakMs = (prefs?.min_break_minutes ?? 10) * MS_PER_MIN;
  const maxFocusMs = Math.max((prefs?.max_focus_block_minutes ?? 90) * MS_PER_MIN, MIN_SESSION_MS);
  const fixed = dayObstacles(windowStartMs, windowEndMs, {
    includePlans: opts.includePlans,
    excludeBlockId: opts.parentBlockId ?? null,
  });
  const gaps = buildGaps(windowStartMs, windowEndMs, fixed, breakMs);
  const ins = insBlock();
  let blocksCreated = 0;

  for (const t of tasks) {
    const sessions = splitIntoSessions((t.estimated_minutes ?? DEFAULT_EST_MIN) * MS_PER_MIN, maxFocusMs);
    let placedAny = false;
    for (const want of sessions) {
      const pick = pickGap(gaps, want);
      if (!pick) break;
      const startMs = pick.gap.cursor;
      const endMs = startMs + pick.len;
      ins.run(t.task_id, t.title, new Date(startMs).toISOString(), new Date(endMs).toISOString(), opts.parentBlockId ?? null, opts.runId ?? null);
      pick.gap.cursor = endMs + breakMs;
      blocksCreated++;
      placedAny = true;
    }
    if (placedAny) placedTaskIds.add(t.task_id);
  }
  return { blocksCreated, placedTaskIds };
}

/** STEP 1: propose open-task candidates (not already staged) into the flight-plan.
 * Habits are excluded — they're auto-placed daily from their recurrence, so they
 * shouldn't flood the flight-plan as one-off candidates. */
export function fillFlightPlanCandidates(owner: string = currentOwnerId()): number {
  const candidates = sqlite
    .prepare(
      `SELECT id FROM tasks
        WHERE owner_id = ? AND status = 'open'
          AND subtype IS NOT 'habit'
          AND parent_id IS NULL
          AND recurrence_parent_id IS NULL
          AND id NOT IN (SELECT task_id FROM flight_plan WHERE owner_id = ?)
        ORDER BY priority, COALESCE(due_at, '9999-12-31'), id
        LIMIT ?`
    )
    .all(owner, owner, CANDIDATE_LIMIT) as { id: string }[];
  const { m } = sqlite.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get(owner) as { m: number };
  // Filled candidates arrive SELECTED (deselect-to-exclude model, req 8): manual
  // staging already inserts selected = 1, so both paths now align.
  const ins = sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`);
  let pos = m + 1;
  let added = 0;
  for (const c of candidates) if (ins.run(owner, c.id, pos++).changes > 0) added++;
  return added;
}

/**
 * STEP 2: place SELECTED staged tasks. Plans first (tag-matched), then the
 * workday fallback if enabled. `blockId` scopes to a single Plan (legacy path).
 */
export function placeFlightPlan(owner: string = currentOwnerId(), opts: { date?: string; blockId?: string; silent?: boolean } = {}): AutoResult {
  const date = opts.date ?? localISODate();
  const prefs = prefsOf(owner);
  const tz = prefs?.timezone || serverTimezone();
  const staged = selectedStaged(owner, date);
  const runId = newId(); // stamps every block this run creates, so Undo can target it (D2)

  // ── Legacy single-Plan scope: place tag-matched staged tasks into one Plan ──
  if (opts.blockId != null) {
    const block = sqlite.prepare(`SELECT start_at, end_at, tag, category_id FROM time_blocks WHERE id = ?`).get(opts.blockId) as
      | { start_at: string; end_at: string; tag: string | null; category_id: string | null }
      | undefined;
    if (!block) return { step: 'place', blocksCreated: 0, placed: 0, unplaced: staged.length };
    clearPriorAutoInWindow(Date.parse(block.start_at), Date.parse(block.end_at));
    let cands: StagedTask[];
    let ordered: StagedTask[];
    if (block.category_id) {
      // 0069 category Plan: fill ONLY its category candidates (NOT every staged task) —
      // the same secondary-tag + opt-out filter as the general Pass 1.5.
      cands = categoryCandidates(staged, block.category_id);
      ordered = cands; // preserve staged order (deterministic)
    } else {
      const catchAll = !!(sqlite
        .prepare(`SELECT 1 FROM pattern_types WHERE name = ? AND catch_all = 1 LIMIT 1`)
        .get(block.tag) as {} | undefined);
      if (catchAll) {
        // Catch-all Plan: accept every staged task, sorted by priority only.
        cands = staged;
        ordered = [...staged].sort((a, b) => a.priority - b.priority || a.task_id.localeCompare(b.task_id));
      } else {
        // Phase 5: match on ANY of the Plan's tags; dilute secondaries in ordering.
        const weights = planTagWeights(opts.blockId, block.tag);
        const planTags = [...weights.keys()];
        cands = planTags.length ? staged.filter((t) => planTags.some((name) => t.tags.includes(name))) : staged;
        ordered = orderForPlan(cands, weights);
      }
    }
    const r = placeIntoWindow(ordered, Date.parse(block.start_at), Date.parse(block.end_at), prefs, { parentBlockId: opts.blockId, runId });
    recordRun(owner, runId, r.blocksCreated);
    if (!opts.silent) broadcast(owner, 'auto:placed', { blocksCreated: r.blocksCreated, placed: r.placedTaskIds.size, unplaced: cands.length - r.placedTaskIds.size });
    if (r.placedTaskIds.size > 0) {
      const del = sqlite.prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`);
      for (const id of r.placedTaskIds) del.run(owner, id);
      if (!opts.silent) broadcast(owner, 'flight_plan:updated', { removed: r.placedTaskIds.size });
    }
    return { step: 'place', blocksCreated: r.blocksCreated, placed: r.placedTaskIds.size, unplaced: cands.length - r.placedTaskIds.size, placedInPlans: r.placedTaskIds.size, placedInWorkday: 0 };
  }

  // ── General Auto: Plans first, then the workday fallback ────────────────────
  clearPriorAuto(date, tz);
  const placedIds = new Set<string>();
  let blocksCreated = 0;

  // Pass 1 — fill each tagged Plan with its matching tasks. Tag-matched Plans run
  // first (so they get first pick of their candidates); catch-all Plans run last
  // and absorb whatever's left. Within each group, Plans run earliest-first.
  const allPlans = dayPlans(date, tz);
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
      const weights = planTagWeights(plan.id, plan.tag);
      const planTags = [...weights.keys()];
      cands = staged.filter((t) => !placedIds.has(t.task_id) && planTags.some((name) => t.tags.includes(name)));
      ordered = orderForPlan(cands, weights);
    }
    if (cands.length === 0) continue;
    const r = placeIntoWindow(ordered, Date.parse(plan.start_at), Date.parse(plan.end_at), prefs, { parentBlockId: plan.id, runId });
    r.placedTaskIds.forEach((id) => placedIds.add(id));
    blocksCreated += r.blocksCreated;
  }

  // Pass 1.5 — category Plans (0069). Disjoint from Pass 1 (tag XOR category_id), so no
  // block is filled twice. Each is filled with its category candidates (secondary-tag
  // match + direction opt-out filter), preserving staged order. Runs immediately after
  // Pass 1 and before the direction-window pass, so category blocks supersede pattern
  // windows for their span (via dayObstacles includePlans) just like tag-Plans.
  for (const plan of dayCategoryPlans(date, tz)) {
    const filtered = categoryCandidates(staged, plan.category_id).filter((t) => !placedIds.has(t.task_id));
    if (filtered.length === 0) continue;
    const r = placeIntoWindow(filtered, Date.parse(plan.start_at), Date.parse(plan.end_at), prefs, { parentBlockId: plan.id, runId });
    r.placedTaskIds.forEach((id) => placedIds.add(id));
    blocksCreated += r.blocksCreated;
  }
  const placedInPlans = placedIds.size;

  // Pass 2a — direction-window placement (tag-matched). Runs UNCONDITIONALLY: this is
  // part of tag-matched placement (tap 2), not the priority fill. Direction-tagged
  // tasks are constrained to their direction's pattern windows (union, earliest-first),
  // flowing around the Plans. Per-direction auto_fill (pattern_prefs) is still honored.
  // Leftover capacity is left OPEN here — the workday/priority fill is the separate,
  // explicit fillByPriority() step (tap 3, D5).
  const dayType = resolveDayType(owner, date);
  const patWindows = getPatternBlocks(owner, dayType);
  // Track tasks gated off by per-direction auto_fill=false so Pass 2b skips them too.
  const directionGatedOffIds = new Set<string>();
  if (Object.keys(patWindows).length > 0) {
    const dprefs = getPatternPrefs(owner);
    const dirNameToId = new Map<string, string>(); // direction tag name → id
    const ids = Object.keys(patWindows);
    const dirTags = sqlite
      .prepare(`SELECT id, name FROM tags WHERE id IN (${ids.map(() => '?').join(',')}) AND kind = 'pattern'`)
      .all(...ids) as { id: string; name: string }[];
    for (const dt of dirTags) dirNameToId.set(dt.name, dt.id);

    for (const t of staged.filter((s) => !placedIds.has(s.task_id))) {
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
        const r = placeIntoWindow([t], winStart, winEnd, prefs, { parentBlockId: null, includePlans: true, runId });
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
    const remaining = staged.filter((t) => !placedIds.has(t.task_id) && !directionGatedOffIds.has(t.task_id));
    if (remaining.length > 0) {
      // When a daily_plan has been authored for today, it already encodes the
      // preferred sequence (LLM or deterministic) — preserve that order so placement
      // faithfully executes what authoring decided. Without a daily_plan, fall back
      // to the fill_order pref (pre-Phase-M backward-compatible behaviour).
      const hasDailyPlan = !!(sqlite
        .prepare(`SELECT 1 FROM daily_plan WHERE owner_id = ? AND date = ? LIMIT 1`)
        .get(owner, date));
      const fillOrder = prefs?.fill_order ?? 'priority';
      const ordered = hasDailyPlan
        ? remaining // selectedStaged already ordered by daily_plan.position
        : fillOrder === 'overdue' ? orderByOverdue(remaining) : orderForPlan(remaining);
      const wsMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_start ?? '09:00', tz));
      const weMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_end ?? '18:00', tz));
      const r = placeIntoWindow(ordered, wsMs, weMs, prefs, { parentBlockId: null, includePlans: true, runId });
      r.placedTaskIds.forEach((id) => placedIds.add(id));
      blocksCreated += r.blocksCreated;
      placedInWorkday = r.placedTaskIds.size;
    }
  }

  recordRun(owner, runId, blocksCreated);

  // Link block_id in daily_plan for every placed task (Phase M §0 / A3: the block
  // detail view joins daily_plan on block_id to display the per-task rationale).
  if (placedIds.size > 0) {
    const linkBlk = sqlite.prepare(
      `UPDATE daily_plan
          SET block_id = (
            SELECT id FROM time_blocks
             WHERE task_id = ? AND is_auto = 1 AND auto_run_id = ? AND block_kind = 'task'
             ORDER BY start_at LIMIT 1
          )
        WHERE owner_id = ? AND date = ? AND task_id = ?`
    );
    for (const taskId of placedIds) linkBlk.run(taskId, runId, owner, date, taskId);
  }

  const placed = placedIds.size;
  const unplaced = staged.length - placed;
  if (!opts.silent) broadcast(owner, 'auto:placed', { blocksCreated, placed, unplaced });
  if (placedIds.size > 0) {
    const del = sqlite.prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`);
    for (const id of placedIds) del.run(owner, id);
    if (!opts.silent) broadcast(owner, 'flight_plan:updated', { removed: placedIds.size });
  }
  return { step: 'place', blocksCreated, placed, unplaced, placedInPlans, placedInWorkday };
}

/**
 * The explicit priority top-up (tap 3, D5). Tag-matched placement (placeFlightPlan)
 * leaves leftover capacity OPEN; this fills the workday window with the highest-
 * priority still-unplaced selected tasks (P1 first), flowing around everything already
 * placed (Plans, meetings, prior auto/manual blocks). Never auto-runs — it is always an
 * explicit tap, in both modes. Gated by the `auto_fill_workday` pref (off → no-op).
 */
export function fillByPriority(owner: string = currentOwnerId(), opts: { date?: string } = {}): AutoResult {
  const date = opts.date ?? localISODate();
  const prefs = prefsOf(owner);
  const tz = prefs?.timezone || serverTimezone();
  if ((prefs?.auto_fill_workday ?? 1) !== 1) {
    return { step: 'place', blocksCreated: 0, placed: 0, unplaced: 0, placedInPlans: 0, placedInWorkday: 0 };
  }

  const staged = selectedStaged(owner, date);
  // Tasks already auto-placed today are not re-placed (this top-up runs AFTER tap 2,
  // and must not clear or duplicate those placements).
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  const placedTaskIds = new Set(
    (sqlite
      .prepare(
        `SELECT DISTINCT task_id FROM time_blocks
          WHERE is_auto = 1 AND source_kind = 'agent' AND block_kind = 'task' AND task_id IS NOT NULL
            AND start_at < ? AND end_at > ?`,
      )
      .all(dayEndISO, dayStartISO) as { task_id: string }[]).map((r) => r.task_id),
  );
  const remaining = staged.filter((t) => !placedTaskIds.has(t.task_id));
  if (remaining.length === 0) {
    return { step: 'place', blocksCreated: 0, placed: 0, unplaced: 0, placedInPlans: 0, placedInWorkday: 0 };
  }

  const wsMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_start ?? '09:00', tz));
  const weMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_end ?? '18:00', tz));
  // orderForPlan with no weights sorts priority-first (P1 first). includePlans flows
  // around Plans and the tag-matched blocks tap 2 already created.
  const runId = newId();
  const r = placeIntoWindow(orderForPlan(remaining), wsMs, weMs, prefs, { parentBlockId: null, includePlans: true, runId });
  recordRun(owner, runId, r.blocksCreated);
  const placed = r.placedTaskIds.size;
  broadcast(owner, 'auto:placed', { blocksCreated: r.blocksCreated, placed, unplaced: remaining.length - placed });
  if (r.placedTaskIds.size > 0) {
    const del = sqlite.prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`);
    for (const id of r.placedTaskIds) del.run(owner, id);
    broadcast(owner, 'flight_plan:updated', { removed: r.placedTaskIds.size });
  }
  return { step: 'place', blocksCreated: r.blocksCreated, placed, unplaced: remaining.length - placed, placedInPlans: 0, placedInWorkday: placed };
}

/**
 * Undo the LAST placement run (D2 — single-step, no stack). Deletes only the blocks
 * stamped with the owner's most recent run_id (never manual or meeting blocks, which
 * carry no auto_run_id), re-stages those tasks onto the flight-plan (selected), and
 * clears the pointer so a second undo is a no-op. Returns the counts.
 */
export function undoLastAuto(owner: string = currentOwnerId()): { removed: number; restaged: number } {
  const runId = (sqlite.prepare(`SELECT last_auto_run_id FROM owners WHERE id = ?`).get(owner) as { last_auto_run_id: string | null } | undefined)?.last_auto_run_id;
  if (!runId) return { removed: 0, restaged: 0 };

  // The tasks this run placed (re-stage them so the user can re-place/adjust).
  const taskIds = (sqlite.prepare(`SELECT DISTINCT task_id FROM time_blocks WHERE auto_run_id = ? AND task_id IS NOT NULL`).all(runId) as { task_id: string }[]).map((r) => r.task_id);

  const removed = sqlite.prepare(`DELETE FROM time_blocks WHERE auto_run_id = ?`).run(runId).changes;

  let pos = (sqlite.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get(owner) as { m: number }).m + 1;
  const insFp = sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`);
  const selFp = sqlite.prepare(`UPDATE flight_plan SET selected = 1 WHERE owner_id = ? AND task_id = ?`);
  let restaged = 0;
  for (const taskId of taskIds) {
    if (insFp.run(owner, taskId, pos).changes > 0) pos++;
    else selFp.run(owner, taskId); // already staged → just re-select it
    restaged++;
  }

  sqlite.prepare(`UPDATE owners SET last_auto_run_id = NULL WHERE id = ?`).run(owner); // single-step undo
  broadcast(owner, 'auto:undone', { removed, restaged });
  return { removed, restaged };
}

/** Clear prior agent placements overlapping a specific window (the single-Plan path). */
function clearPriorAutoInWindow(windowStartMs: number, windowEndMs: number): void {
  sqlite
    .prepare(
      `DELETE FROM time_blocks
        WHERE is_auto = 1 AND is_locked = 0 AND block_kind = 'task' AND source_kind = 'agent'
          AND status NOT IN ('completed','skipped')
          AND start_at < ? AND end_at > ?`
    )
    .run(new Date(windowEndMs).toISOString(), new Date(windowStartMs).toISOString());
}

/**
 * Legacy combined entry point — retained for any callers that haven't migrated
 * to the explicit fill/place split. The UI now calls fillFlightPlanCandidates
 * and placeFlightPlan directly through separate endpoints.
 */
export function runAuto(opts: { date?: string; blockId?: string } = {}): AutoResult {
  const owner = currentOwnerId();
  if (flightPlanCount(owner) === 0) {
    const added = fillFlightPlanCandidates(owner);
    broadcast(owner, 'flight_plan:filled', { added });
    return { step: 'fill', candidatesAdded: added };
  }
  return placeFlightPlan(owner, opts);
}

/** The owner's trust mode (D1). Defaults to the safe 'suggest' if prefs are absent. */
export function autoMode(owner: string = currentOwnerId()): 'suggest' | 'schedule' {
  const row = sqlite.prepare(`SELECT auto_mode FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as { auto_mode?: string } | undefined;
  return row?.auto_mode === 'schedule' ? 'schedule' : 'suggest';
}

/**
 * Schedule-mode zero-click path (D1): on ingest, collapse taps 1+2 — fill candidates
 * (all selected) and place tag-matched work in one pass. No-op in suggest mode (the
 * user drives the taps). The explicit priority top-up (tap 3) is never silent and is
 * NOT run here. Returns the place result, or null when suggest mode / nothing to do.
 */
export function autoScheduleOnIngest(
  owner: string = currentOwnerId(),
  opts: { date?: string } = {},
): AutoResult | null {
  if (autoMode(owner) !== 'schedule') return null;
  fillFlightPlanCandidates(owner); // stage any new open tasks, all selected
  const date = opts.date ?? localISODate();
  if (selectedStaged(owner, date).length === 0) return null;
  return placeFlightPlan(owner, opts);
}
