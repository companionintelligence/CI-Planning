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
import { localISODate } from '../lib/dates.js';
import { buildGaps, pickGap, splitIntoSessions, dayObstacles, MS_PER_MIN } from './scheduler.js';

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
  return (
    sqlite
      .prepare(`SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = ?`)
      .all(taskId) as { name: string }[]
  ).map((r) => r.name);
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
 * Order candidates for a Plan: priority first, then tag-overlap "centrality"
 * (a task whose tags are shared by more of the other candidates clusters
 * related work together), then due date.
 */
function orderForPlan(cands: StagedTask[]): StagedTask[] {
  const freq = new Map<string, number>();
  for (const c of cands) for (const t of c.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
  const overlap = (c: StagedTask) => c.tags.reduce((s, t) => s + ((freq.get(t) ?? 1) - 1), 0);
  const dueRank = (c: StagedTask) => (c.due_at ? Date.parse(c.due_at) : Number.POSITIVE_INFINITY);
  return [...cands].sort(
    (a, b) => a.priority - b.priority || overlap(b) - overlap(a) || dueRank(a) - dueRank(b) || a.task_id.localeCompare(b.task_id)
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

/** STEP 1: propose open-task candidates (not already staged) into the flight-plan. */
export function fillFlightPlanCandidates(owner: string = currentOwnerId()): number {
  const candidates = sqlite
    .prepare(
      `SELECT id FROM tasks
        WHERE owner_id = ? AND status = 'open'
          AND id NOT IN (SELECT task_id FROM flight_plan WHERE owner_id = ?)
        ORDER BY priority, COALESCE(due_at, '9999-12-31'), id
        LIMIT ?`
    )
    .all(owner, owner, CANDIDATE_LIMIT) as { id: string }[];
  const { m } = sqlite.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get(owner) as { m: number };
  const ins = sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 0, ?)`);
  let pos = m + 1;
  let added = 0;
  for (const c of candidates) if (ins.run(owner, c.id, pos++).changes > 0) added++;
  return added;
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
    const cands = block.tag ? staged.filter((t) => t.tags.includes(block.tag!)) : staged;
    const r = placeIntoWindow(orderForPlan(cands), Date.parse(block.start_at), Date.parse(block.end_at), prefs, { parentBlockId: opts.blockId });
    broadcast(owner, 'auto:placed', { blocksCreated: r.blocksCreated, placed: r.placedTaskIds.size, unplaced: cands.length - r.placedTaskIds.size });
    return { step: 'place', blocksCreated: r.blocksCreated, placed: r.placedTaskIds.size, unplaced: cands.length - r.placedTaskIds.size, placedInPlans: r.placedTaskIds.size, placedInWorkday: 0 };
  }

  // ── General Auto: Plans first, then the workday fallback ────────────────────
  clearPriorAuto(date, tz);
  const placedIds = new Set<string>();
  let blocksCreated = 0;

  // Pass 1 — fill each tagged Plan with its tag-matched, still-unplaced tasks.
  for (const plan of dayPlans(date, tz)) {
    const cands = staged.filter((t) => !placedIds.has(t.task_id) && plan.tag && t.tags.includes(plan.tag));
    if (cands.length === 0) continue;
    const r = placeIntoWindow(orderForPlan(cands), Date.parse(plan.start_at), Date.parse(plan.end_at), prefs, { parentBlockId: plan.id });
    r.placedTaskIds.forEach((id) => placedIds.add(id));
    blocksCreated += r.blocksCreated;
  }
  const placedInPlans = placedIds.size;

  // Pass 2 — workday fallback (secondary, toggleable). Flows around the Plans.
  if ((prefs?.auto_fill_workday ?? 1) === 1) {
    const windowStartMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_start ?? '09:00', tz));
    const windowEndMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_end ?? '18:00', tz));
    const remaining = staged.filter((t) => !placedIds.has(t.task_id));
    const r = placeIntoWindow(remaining, windowStartMs, windowEndMs, prefs, { parentBlockId: null, includePlans: true });
    r.placedTaskIds.forEach((id) => placedIds.add(id));
    blocksCreated += r.blocksCreated;
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
 * The two-step Auto entry point. No selected staged items → propose candidates;
 * some selected → place them. Never touches anything outside the flight-plan.
 */
export function runAuto(opts: { date?: string; blockId?: string } = {}): AutoResult {
  const owner = currentOwnerId();
  if (selectedStaged(owner).length === 0) {
    const added = fillFlightPlanCandidates(owner);
    broadcast(owner, 'flight_plan:filled', { added });
    return { step: 'fill', candidatesAdded: added };
  }
  return placeFlightPlan(owner, opts);
}
