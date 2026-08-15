import { store } from '../db/store.js';
import { utcDayBounds, zonedWallTimeToUTC } from '../lib/tz.js';
import { ownerTimezone } from './recurrence-generate.js';
import { MS_PER_MIN, buildGaps, type Gap } from './scheduler.js';
import { stage } from '../services/flight-plan.js';
import { revertTaskPlacementStatus } from '../services/block-task-sync.js';
import { stampRow } from '../sync/apply.js';
import { writeAudit } from '../lib/audit.js';
import {
  detectDayConflicts, windowsForDate, compareDropOrder,
  type DayConflict, type WindowRange,
} from './day-conflicts.js';

/**
 * The confirmed reflow (Phase 7, parts 3–4).
 *
 * Changing a day's type strands tasks outside their direction's windows.
 * `proposeDayReflow` says exactly what it WOULD do; `applyDayReflow` does it. The two
 * are separate on purpose — the plan's hard requirement is that nothing moves until
 * the owner approves, so proposing must be a pure read.
 *
 * Same-day first: every stranded task is offered a slot inside the NEW windows before
 * anything is proposed for unscheduling. What still cannot fit goes back to the
 * flight-plan — the same re-staging path a deleted block already uses — lowest task
 * priority first (decision 5).
 *
 * The engine is deterministic. The plan allows an LLM to author the proposal when
 * Ollama is present, but requires that a deterministic validator decide and that the
 * deterministic engine be the fallback — so this IS the contract, and an LLM author
 * would have to produce something this could ratify. Not wired up here.
 */

export interface ReflowMove {
  block_id: string;
  task_id: string | null;
  title: string;
  from: { start_at: string; end_at: string };
  to: { start_at: string; end_at: string };
}

export interface ReflowUnschedule {
  block_id: string;
  task_id: string | null;
  title: string;
  /** Why it is being unscheduled, for the confirm dialog. */
  reason: 'no_room';
}

export interface ReflowProposal {
  date: string;
  day_type: string;
  moves: ReflowMove[];
  unschedule: ReflowUnschedule[];
  /** Stranded but never touched — the owner pinned these (decision 6). */
  kept_locked: DayConflict[];
}

interface TaskFacts {
  priority: number | null;
  due_at: string | null;
  estimated_minutes: number | null;
}

/**
 * A gap big enough for the WHOLE block, best-fit.
 *
 * Deliberately not `pickGap`: that truncates to the largest remaining gap when nothing
 * fits, which is right for carving focus sessions but wrong here — the reflow contract
 * is move-or-unschedule, and silently shortening a task is neither.
 */
function fitWholly(gaps: Gap[], wantMs: number): Gap | null {
  let best: Gap | null = null;
  let leftover = Infinity;
  for (const g of gaps) {
    const free = g.end - g.cursor;
    if (free < wantMs) continue;
    if (free - wantMs < leftover) { best = g; leftover = free - wantMs; }
  }
  return best;
}

/** The day's windows as absolute ms ranges, per direction name. */
async function windowRangesMs(
  owner: string, date: string, tz: string,
): Promise<Map<string, { start: number; end: number }[]>> {
  const byName = await windowsForDate(owner, date);
  const toMs = (min: number) => {
    const hh = String(Math.floor(min / 60)).padStart(2, '0');
    const mm = String(min % 60).padStart(2, '0');
    return Date.parse(zonedWallTimeToUTC(date, `${hh}:${mm}`, tz));
  };
  const out = new Map<string, { start: number; end: number }[]>();
  for (const [name, ranges] of Object.entries(byName)) {
    out.set(name, (ranges as WindowRange[])
      .map((r) => ({ start: toMs(r.startMin), end: toMs(r.endMin) }))
      .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
      .sort((a, b) => a.start - b.start));
  }
  return out;
}

/**
 * What a reflow of `date` would do. Pure read — nothing is written.
 *
 * Placement order is HIGHEST priority first, which is what makes decision 5's
 * "lowest priority unscheduled first" fall out: whatever is left when the windows
 * fill up is, by construction, the lowest-priority work.
 */
export async function proposeDayReflow(owner: string, date: string): Promise<ReflowProposal> {
  const tz = await ownerTimezone(owner);
  const report = await detectDayConflicts(owner, date);
  const kept_locked = report.conflicts.filter((c) => c.is_locked);
  const movable = report.conflicts.filter((c) => !c.is_locked);
  const empty: ReflowProposal = { date, day_type: report.day_type, moves: [], unschedule: [], kept_locked };
  if (movable.length === 0) return empty;

  const prefs = await store()
    .prepare(`SELECT min_break_minutes FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ min_break_minutes: number | null }>(owner);
  const breakMs = (prefs?.min_break_minutes ?? 10) * MS_PER_MIN;

  const facts = await taskFacts(owner, movable.map((c) => c.task_id).filter((t): t is string => !!t));
  const NO_FACTS: TaskFacts = { priority: null, due_at: null, estimated_minutes: null };
  const order = [...movable].sort((a, b) => {
    const fa = facts.get(a.task_id ?? '') ?? NO_FACTS;
    const fb = facts.get(b.task_id ?? '') ?? NO_FACTS;
    // Reverse drop order: what would be dropped LAST is placed FIRST.
    return -compareDropOrder(
      { priority: fa.priority, dueAt: fa.due_at, estimatedMinutes: fa.estimated_minutes },
      { priority: fb.priority, dueAt: fb.due_at, estimatedMinutes: fb.estimated_minutes },
    );
  });

  // Obstacles: everything live on the day EXCEPT the blocks we are re-placing (their
  // current slots are about to be freed, so they must not block their own move).
  const movableIds = new Set(movable.map((c) => c.block_id));
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  const obstacles = (await store()
    .prepare(
      `SELECT id, start_at, end_at FROM time_blocks
        WHERE owner_id = ? AND COALESCE(all_day, 0) = 0
          AND start_at < ? AND end_at > ?
          AND status NOT IN ('completed', 'skipped', 'cancelled', 'missed')`,
    )
    .all<{ id: string; start_at: string; end_at: string }>(owner, dayEndISO, dayStartISO))
    .filter((r) => !movableIds.has(r.id))
    .map((r) => ({ start: Date.parse(r.start_at), end: Date.parse(r.end_at) }));

  const windows = await windowRangesMs(owner, date, tz);
  const moves: ReflowMove[] = [];
  const unschedule: ReflowUnschedule[] = [];

  for (const c of order) {
    const durMs = Date.parse(c.end_at) - Date.parse(c.start_at);
    const placed = placeOne(c, durMs, windows, obstacles, breakMs);
    if (placed) {
      moves.push({
        block_id: c.block_id, task_id: c.task_id, title: c.title,
        from: { start_at: c.start_at, end_at: c.end_at },
        to: { start_at: new Date(placed.start).toISOString(), end_at: new Date(placed.end).toISOString() },
      });
      obstacles.push(placed); // later placements route around this one
    } else {
      unschedule.push({ block_id: c.block_id, task_id: c.task_id, title: c.title, reason: 'no_room' });
    }
  }

  // Report drops in the order they'd be given up, so the dialog reads as the rule does.
  unschedule.reverse();
  return { date, day_type: report.day_type, moves, unschedule, kept_locked };
}

/** First window slot (earliest across this block's directions) that fits it whole. */
function placeOne(
  c: DayConflict,
  durMs: number,
  windows: Map<string, { start: number; end: number }[]>,
  obstacles: { start: number; end: number }[],
  breakMs: number,
): { start: number; end: number } | null {
  const ranges = c.directions
    .map((d) => windows.get(d.trim().toLowerCase()) ?? [])
    .flat()
    .sort((a, b) => a.start - b.start);
  for (const w of ranges) {
    const gap = fitWholly(buildGaps(w.start, w.end, obstacles, breakMs), durMs);
    if (gap) return { start: gap.cursor, end: gap.cursor + durMs };
  }
  return null;
}

async function taskFacts(owner: string, taskIds: string[]): Promise<Map<string, TaskFacts>> {
  const out = new Map<string, TaskFacts>();
  if (taskIds.length === 0) return out;
  const rows = await store()
    .prepare(
      `SELECT id, priority, due_at, estimated_minutes FROM tasks
        WHERE owner_id = ? AND id IN (${taskIds.map(() => '?').join(',')})`,
    )
    .all<{ id: string } & TaskFacts>(owner, ...taskIds);
  for (const r of rows) out.set(r.id, r);
  return out;
}

export interface ReflowApplied {
  moved: number;
  unscheduled: number;
  restaged: number;
}

/**
 * Apply a reflow. The proposal is RECOMPUTED here rather than taken from the client:
 * the owner confirmed an outcome, not a payload, and a stale or hand-edited proposal
 * must not be able to move blocks the current state would not.
 *
 * Unscheduling deletes the block and stages its task back into the flight-plan — the
 * exact path a deleted block already takes — so the work is never silently dropped.
 */
export async function applyDayReflow(owner: string, date: string): Promise<ReflowApplied> {
  const proposal = await proposeDayReflow(owner, date);
  let moved = 0;
  let unscheduled = 0;
  let restaged = 0;

  await store().transaction(async () => {
    const upd = store().prepare(
      `UPDATE time_blocks SET start_at = ?, end_at = ?, is_auto = 0 WHERE id = ? AND owner_id = ?`,
    );
    for (const m of proposal.moves) {
      const info = await upd.run(m.to.start_at, m.to.end_at, m.block_id, owner);
      if (info.changes > 0) {
        moved++;
        // Same stamp a manual move makes: a queued offline op holding the pre-reflow
        // times must lose LWW rather than drag the block back.
        await stampRow('block', m.block_id, ['startAt', 'endAt']);
      }
    }
    for (const u of proposal.unschedule) {
      const info = await store()
        .prepare(`DELETE FROM time_blocks WHERE id = ? AND owner_id = ?`)
        .run(u.block_id, owner);
      if (info.changes === 0) continue;
      unscheduled++;
      if (!u.task_id) continue;
      await revertTaskPlacementStatus(u.task_id, owner);
      const res = await stage(owner, { taskId: u.task_id });
      if (res.ok && res.added > 0) restaged++;
    }
  });

  if (moved || unscheduled) {
    writeAudit({ ownerId: owner, actor: 'owner', action: 'reflow', entity: `day:${date}` });
  }
  return { moved, unscheduled, restaged };
}
