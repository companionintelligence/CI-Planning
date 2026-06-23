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
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { taskTagNames } from '../services/tags.js';
import { localISODate } from '../lib/dates.js';
import { buildGaps, pickGap, splitIntoSessions, dayObstacles, MS_PER_MIN } from './scheduler.js';
import { entityTagLevels, splitTagString } from '../services/tags.js';
import { getPatternBlocks } from '../services/pattern-blocks.js';
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
}
interface PlanRow {
  id: string;
  start_at: string;
  end_at: string;
  tag: string | null;
}

function tagsOf(taskId: string): string[] {
  return taskTagNames(taskId);
}

function selectedStaged(owner: string): StagedTask[] {
  const rows = sqlite
    .prepare(
      `SELECT fp.task_id, t.title, t.estimated_minutes, t.priority, t.due_at
         FROM flight_plan fp JOIN tasks t ON t.id = fp.task_id
        WHERE fp.owner_id = ? AND fp.selected = 1
        ORDER BY fp.position, t.priority, fp.task_id`
    )
    .all(owner) as Omit<StagedTask, 'tags'>[];
  return rows.map((r) => ({ ...r, priority: r.priority ?? 3, tags: tagsOf(r.task_id) }));
}

/** How many tasks are staged in the flight-plan (selected or not). */
function flightPlanCount(owner: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ?`).get(owner) as { n: number }).n;
}

function prefsOf(owner: string): PrefsRow | undefined {
  return sqlite
    .prepare(`SELECT timezone, workday_start, workday_end, min_break_minutes, max_focus_block_minutes, auto_fill_workday FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as PrefsRow | undefined;
}

/** Tagged, timed Plan containers on `date`, earliest first. */
function dayPlans(date: string, tz: string): PlanRow[] {
  const dayStartISO = zonedWallTimeToUTC(date, '00:00', tz);
  const dayEndISO = new Date(Date.parse(dayStartISO) + 24 * 60 * 60_000).toISOString();
  return sqlite
    .prepare(
      `SELECT id, start_at, end_at, tag FROM time_blocks
        WHERE block_kind = 'timeblock' AND block_type = 'scheduled' AND tag IS NOT NULL
          AND COALESCE(all_day, 0) = 0
          AND start_at < ? AND end_at > ?
        ORDER BY start_at`
    )
    .all(dayEndISO, dayStartISO) as PlanRow[];
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

const insBlock = () =>
  sqlite.prepare(
    `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, parent_block_id)
     VALUES (uuid7(), ?, ?, 'task', ?, ?, 0, 1, 'agent', 'planned', ?)`
  );

/** Clear our OWN prior agent placements for the local day (pattern blocks survive). */
function clearPriorAuto(date: string, tz: string): void {
  const dayStartISO = zonedWallTimeToUTC(date, '00:00', tz);
  const dayEndISO = new Date(Date.parse(dayStartISO) + 24 * 60 * 60_000).toISOString();
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
  opts: { parentBlockId?: string | null; includePlans?: boolean }
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
      ins.run(t.task_id, t.title, new Date(startMs).toISOString(), new Date(endMs).toISOString(), opts.parentBlockId ?? null);
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

/** True for Saturday (6) and Sunday (0) — UTC date-of-week, DST-safe. */
function isWeekendDate(dateStr: string): boolean {
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * STEP 2: place SELECTED staged tasks. Plans first (tag-matched), then the
 * workday fallback if enabled. `blockId` scopes to a single Plan (legacy path).
 */
export function placeFlightPlan(owner: string = currentOwnerId(), opts: { date?: string; blockId?: string } = {}): AutoResult {
  const date = opts.date ?? localISODate();
  const prefs = prefsOf(owner);
  const tz = prefs?.timezone || serverTimezone();
  const staged = selectedStaged(owner);

  // ── Legacy single-Plan scope: place tag-matched staged tasks into one Plan ──
  if (opts.blockId != null) {
    const block = sqlite.prepare(`SELECT start_at, end_at, tag FROM time_blocks WHERE id = ?`).get(opts.blockId) as
      | { start_at: string; end_at: string; tag: string | null }
      | undefined;
    if (!block) return { step: 'place', blocksCreated: 0, placed: 0, unplaced: staged.length };
    clearPriorAutoInWindow(Date.parse(block.start_at), Date.parse(block.end_at));
    // Phase 5: match on ANY of the Plan's tags (top or secondary); dilute the
    // secondary ones in the ordering. No tags → place everything (legacy).
    const weights = planTagWeights(opts.blockId, block.tag);
    const planTags = [...weights.keys()];
    const cands = planTags.length ? staged.filter((t) => planTags.some((name) => t.tags.includes(name))) : staged;
    const r = placeIntoWindow(orderForPlan(cands, weights), Date.parse(block.start_at), Date.parse(block.end_at), prefs, { parentBlockId: opts.blockId });
    broadcast(owner, 'auto:placed', { blocksCreated: r.blocksCreated, placed: r.placedTaskIds.size, unplaced: cands.length - r.placedTaskIds.size });
    return { step: 'place', blocksCreated: r.blocksCreated, placed: r.placedTaskIds.size, unplaced: cands.length - r.placedTaskIds.size, placedInPlans: r.placedTaskIds.size, placedInWorkday: 0 };
  }

  // ── General Auto: Plans first, then the workday fallback ────────────────────
  clearPriorAuto(date, tz);
  const placedIds = new Set<string>();
  let blocksCreated = 0;

  // Pass 1 — fill each tagged Plan with its tag-matched, still-unplaced tasks.
  // Phase 5: a task matches via ANY of the Plan's tags (top or secondary); the
  // diluted weights bias ordering toward the Plan's primary work.
  for (const plan of dayPlans(date, tz)) {
    const weights = planTagWeights(plan.id, plan.tag);
    const planTags = [...weights.keys()];
    const cands = staged.filter((t) => !placedIds.has(t.task_id) && planTags.some((name) => t.tags.includes(name)));
    if (cands.length === 0) continue;
    const r = placeIntoWindow(orderForPlan(cands, weights), Date.parse(plan.start_at), Date.parse(plan.end_at), prefs, { parentBlockId: plan.id });
    r.placedTaskIds.forEach((id) => placedIds.add(id));
    blocksCreated += r.blocksCreated;
  }
  const placedInPlans = placedIds.size;

  // Pass 2 — workday fallback (secondary, toggleable). Flows around the Plans.
  // When pattern_blocks are configured, direction-tagged tasks are constrained to
  // their direction's windows (union, earliest-first); direction-less tasks use the
  // classic workday_start/workday_end window (backward-compatible).
  //
  // Per-pattern gating (0040): each direction's auto_fill is checked against
  // pattern_prefs. When all pattern_prefs rows default to auto_fill=1 AND
  // auto_fill_workday=1, output is byte-identical to the pre-0040 behavior.
  if ((prefs?.auto_fill_workday ?? 1) === 1) {
    const dayType = isWeekendDate(date) ? 'weekend' : 'workday';
    const patWindows = getPatternBlocks(owner, dayType);
    // Load per-direction auto_fill prefs. Missing row → default { auto_fill: true }.
    const dprefs = getPatternPrefs(owner);
    const dirNameToId = new Map<string, string>(); // direction tag name → id

    if (Object.keys(patWindows).length > 0) {
      const ids = Object.keys(patWindows);
      const dirTags = sqlite
        .prepare(`SELECT id, name FROM tags WHERE id IN (${ids.map(() => '?').join(',')}) AND kind = 'pattern'`)
        .all(...ids) as { id: string; name: string }[];
      for (const dt of dirTags) dirNameToId.set(dt.name, dt.id);
    }

    const remaining = staged.filter((t) => !placedIds.has(t.task_id));

    if (dirNameToId.size > 0) {
      // Pass 2a — direction-tagged tasks → their direction's windows (union, earliest-first).
      // Per-pattern gating: skip a direction whose auto_fill pref is false.
      for (const t of remaining) {
        if (placedIds.has(t.task_id)) continue;
        const taskDirIds = t.tags
          .map((name) => dirNameToId.get(name))
          .filter((id): id is string => id !== undefined);
        if (taskDirIds.length === 0) continue;
        // Filter to directions whose auto_fill is enabled (missing row → default true).
        const enabledDirIds = taskDirIds.filter((dirId) => (dprefs[dirId]?.auto_fill ?? true));
        if (enabledDirIds.length === 0) continue;
        const allRanges = enabledDirIds
          .flatMap((did) => patWindows[did] ?? [])
          .sort((a, b) => a.start_time.localeCompare(b.start_time));
        for (const range of allRanges) {
          if (placedIds.has(t.task_id)) break;
          const winStart = Date.parse(zonedWallTimeToUTC(date, range.start_time, tz));
          const winEnd   = Date.parse(zonedWallTimeToUTC(date, range.end_time, tz));
          const r = placeIntoWindow([t], winStart, winEnd, prefs, { parentBlockId: null, includePlans: true });
          r.placedTaskIds.forEach((id) => placedIds.add(id));
          blocksCreated += r.blocksCreated;
        }
      }
      // Pass 2b — direction-less tasks → classic workday_start/workday_end
      const undirected = remaining.filter(
        (t) => !placedIds.has(t.task_id) && !t.tags.some((n) => dirNameToId.has(n))
      );
      if (undirected.length > 0) {
        const wsMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_start ?? '09:00', tz));
        const weMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_end ?? '18:00', tz));
        const r = placeIntoWindow(undirected, wsMs, weMs, prefs, { parentBlockId: null, includePlans: true });
        r.placedTaskIds.forEach((id) => placedIds.add(id));
        blocksCreated += r.blocksCreated;
      }
    } else {
      // No pattern windows configured → classic single window (backward-compatible)
      const windowStartMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_start ?? '09:00', tz));
      const windowEndMs   = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_end ?? '18:00', tz));
      const r = placeIntoWindow(remaining, windowStartMs, windowEndMs, prefs, { parentBlockId: null, includePlans: true });
      r.placedTaskIds.forEach((id) => placedIds.add(id));
      blocksCreated += r.blocksCreated;
    }
  }

  const placed = placedIds.size;
  const unplaced = staged.length - placed;
  broadcast(owner, 'auto:placed', { blocksCreated, placed, unplaced });
  return { step: 'place', blocksCreated, placed, unplaced, placedInPlans, placedInWorkday: placed - placedInPlans };
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
 * The two-step Auto entry point. The step is keyed off whether the flight-plan is
 * EMPTY (req 8): empty → propose candidates (all selected); non-empty → place the
 * selected ones. Keying off selection count broke once fill marked everything
 * selected (and again when the user deselected everything). Never touches anything
 * outside the flight-plan.
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
