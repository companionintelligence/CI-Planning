import { eq, asc } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, timeBlocks, schedulingPrefs } from '../db/schema.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { serverTimezone, zonedWallTimeToUTC, utcDayBounds } from '../lib/tz.js';
import { orderForToday } from '../agents/plan.js';
import { currentOwnerId } from '../lib/context.js';
import { blockedTaskIds } from './deps.js';

type Task = InferSelectModel<typeof tasks>;

export interface ScheduleResult {
  date: string;
  blocksCreated: number;
  blocksRemoved: number;
  tasksScheduled: number;     // every focus session placed
  partiallyScheduled: number; // some sessions placed, capacity ran out
  unscheduled: number;        // selected for today but nothing fit
  deferred: number;           // ready work left in the backlog for a future day
}

/** A free window in the day, with a moving cursor as blocks are packed in. */
export interface Gap {
  start: number;
  end: number;
  cursor: number;
}

export const MS_PER_MIN = 60_000;
// Don't carve a focus block shorter than this — sub-quarter-hour slivers aren't useful.
const MIN_SESSION_MS = 15 * MS_PER_MIN;
// Cap how many tasks the optional LLM ordering pass sees, to bound the prompt.
const AI_ORDER_LIMIT = 30;

export async function runScheduler(date: string): Promise<ScheduleResult> {
  logger.info('scheduler.run', { date });

  const empty: ScheduleResult = {
    date,
    blocksCreated: 0,
    blocksRemoved: 0,
    tasksScheduled: 0,
    partiallyScheduled: 0,
    unscheduled: 0,
    deferred: 0,
  };

  const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, currentOwnerId()));
  if (!prefs) return empty;

  // Workday hours are wall-clock in the user's zone; convert to real UTC instants.
  const tz = prefs.timezone || serverTimezone();
  const dayStartMs = new Date(zonedWallTimeToUTC(date, prefs.workdayStart ?? '09:00', tz)).getTime();
  const dayEndMs = new Date(zonedWallTimeToUTC(date, prefs.workdayEnd ?? '18:00', tz)).getTime();
  if (dayEndMs <= dayStartMs) return empty;

  const breakMs = (prefs.minBreakMinutes ?? 10) * MS_PER_MIN;
  const maxFocusMs = Math.max((prefs.maxFocusBlockMinutes ?? 90) * MS_PER_MIN, MIN_SESSION_MS);

  // Clear auto, unlocked, not-yet-actioned blocks across the whole *local* day so
  // re-running is idempotent (locked blocks and completed/skipped ones survive).
  const { start: dayLoISO, end: dayHiISO } = utcDayBounds(date, tz);
  const removed = sqlite
    .prepare(
      `DELETE FROM time_blocks
       WHERE start_at >= ? AND start_at < ? AND is_auto = 1 AND is_locked = 0
         AND status NOT IN ('completed','skipped')
       RETURNING id`
    )
    .all(dayLoISO, dayHiISO) as { id: string }[];

  // Fixed events (locked blocks + meetings) that overlap the workday window.
  const dayStartISO = new Date(dayStartMs).toISOString();
  const dayEndISO = new Date(dayEndMs).toISOString();
  const fixed = (
    sqlite
      .prepare(
        `SELECT start_at, end_at FROM time_blocks
         WHERE start_at < ? AND end_at > ? AND (is_locked = 1 OR block_kind = 'meeting')`
      )
      .all(dayEndISO, dayStartISO) as { start_at: string; end_at: string }[]
  ).map((r) => ({ start: new Date(r.start_at).getTime(), end: new Date(r.end_at).getTime() }));

  let blocksCreated = 0;
  let tasksScheduled = 0;
  let partiallyScheduled = 0;
  let unscheduled = 0;
  let deferred = 0;

  // The "today set": open tasks that are undated, overdue, or due within the
  // planning horizon. Tasks due further out aren't pulled into today and don't
  // inflate the unscheduled count (most urgent first; nulls sort first in ASC).
  const horizonDays = Math.max(1, prefs.planningHorizonDays ?? 7);
  const [hy, hm, hd] = date.split('-').map(Number);
  const horizonDate = new Date(Date.UTC(hy, hm - 1, hd + horizonDays)).toISOString().slice(0, 10);
  const horizonEndISO = utcDayBounds(horizonDate, tz).end;

  // Drop blocked (incomplete blocker) and still-deferred tasks first — they
  // aren't ready, so they are not "unscheduled" or "deferred".
  const blockedIds = blockedTaskIds();
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'open'))
    .orderBy(asc(tasks.priority), asc(tasks.scheduledFor), asc(tasks.dueAt), asc(tasks.id));
  const ready = rows.filter(
    (t) => !blockedIds.has(t.id) && !(t.deferUntil && t.deferUntil >= dayHiISO)
  );
  const candidates = ready.filter(
    (t) => !t.dueAt || t.dueAt < horizonEndISO || t.scheduledFor === date
  );
  deferred += ready.length - candidates.length;

  // A task with a fixed time-of-day that is due on this local day is pinned at
  // that time (an appointment); flexible work is packed around it.
  const isPinned = (t: (typeof candidates)[number]) =>
    !!t.taskTime && !!t.dueAt && t.dueAt >= dayLoISO && t.dueAt < dayHiISO;

  for (const t of candidates.filter(isPinned)) {
    const startISO = zonedWallTimeToUTC(date, (t.taskTime as string).slice(0, 5), tz);
    const startMs = new Date(startISO).getTime();
    const endMs = startMs + (t.estimatedMinutes ?? 30) * MS_PER_MIN;
    await db.insert(timeBlocks).values({
      taskId: t.id,
      title: t.title,
      blockKind: 'task',
      startAt: startISO,
      endAt: new Date(endMs).toISOString(),
      isAuto: true,
      isLocked: false,
      sourceKind: 'agent',
      status: 'planned',
    });
    fixed.push({ start: startMs, end: endMs }); // flexible work schedules around the pin
    blocksCreated++;
    tasksScheduled++;
  }

  // Build free windows AFTER pinning so the packer avoids pinned appointments too.
  const gaps = buildGaps(dayStartMs, dayEndMs, fixed, breakMs);

  // Optional AI pass (planning_mode === 'auto'): reorder the flexible work most-
  // important-first. Placement below stays deterministic, so plans are still
  // reproducible; orderForToday returns the input unchanged when AI is off/down.
  const rankedFlexible = candidates.filter((t) => !isPinned(t));
  const orderedHead = await orderForToday(rankedFlexible.slice(0, AI_ORDER_LIMIT), prefs);
  const flexible = [...orderedHead, ...rankedFlexible.slice(AI_ORDER_LIMIT)] as Task[];

  // Only pull as much flexible work into today as the visible capacity can hold;
  // the rest rolls over instead of being reported as scheduling failures.
  let capacityMs = gaps.reduce((sum, g) => sum + (g.end - g.cursor), 0);
  const todaySet: Task[] = [];
  for (const task of flexible) {
    if (capacityMs <= 0) break;
    todaySet.push(task);
    capacityMs -= (task.estimatedMinutes ?? 30) * MS_PER_MIN;
  }
  deferred += flexible.length - todaySet.length;

  for (const task of todaySet) {
    const estimateMs = (task.estimatedMinutes ?? 30) * MS_PER_MIN;
    const sessions = splitIntoSessions(estimateMs, maxFocusMs); // 180m/90cap -> [90,90]
    const total = sessions.length;
    let placed = 0;

    for (const want of sessions) {
      const pick = pickGap(gaps, want);
      if (!pick) break; // no room for this (or any later) session
      const startMs = pick.gap.cursor;
      const endMs = startMs + pick.len;
      await db.insert(timeBlocks).values({
        taskId: task.id,
        title: total > 1 ? `${task.title} (${placed + 1}/${total})` : task.title,
        blockKind: 'task',
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
        isAuto: true,
        isLocked: false,
        sourceKind: 'agent',
        status: 'planned',
      });
      pick.gap.cursor = endMs + breakMs;
      blocksCreated++;
      placed++;
    }

    if (placed === 0) unscheduled++;
    else if (placed < total) partiallyScheduled++;
    else tasksScheduled++;
  }

  const result: ScheduleResult = {
    date,
    blocksCreated,
    blocksRemoved: removed.length,
    tasksScheduled,
    partiallyScheduled,
    unscheduled,
    deferred,
  };

  broadcast(currentOwnerId(), 'schedule:done', result);
  logger.info('scheduler.done', result);
  return result;
}

/** Split a duration into focus-sized sessions; the final session may be shorter. */
export function splitIntoSessions(totalMs: number, maxFocusMs: number): number[] {
  const out: number[] = [];
  let rem = totalMs;
  while (rem > 0) {
    const slice = Math.min(rem, maxFocusMs);
    out.push(slice);
    rem -= slice;
  }
  return out.length ? out : [Math.min(totalMs, maxFocusMs)];
}

/**
 * Choose where a session of `wantMs` goes. Prefers a gap that fits it fully
 * (best-fit: least leftover, to reduce fragmentation); otherwise falls back to
 * the largest remaining gap and truncates the session to fit. Scans *all* gaps,
 * so smaller tasks backfill holes a bigger task skipped.
 */
export function pickGap(gaps: Gap[], wantMs: number): { gap: Gap; len: number } | null {
  let fit: Gap | null = null;
  let fitLeftover = Infinity;
  let largest: Gap | null = null;
  let largestFree = 0;

  for (const g of gaps) {
    const free = g.end - g.cursor;
    if (free <= 0) continue;
    if (free >= wantMs && free - wantMs < fitLeftover) {
      fit = g;
      fitLeftover = free - wantMs;
    }
    if (free > largestFree) {
      largest = g;
      largestFree = free;
    }
  }

  if (fit) return { gap: fit, len: wantMs };
  if (largest && largestFree >= MIN_SESSION_MS) return { gap: largest, len: largestFree };
  return null;
}

/**
 * Fixed obstacles overlapping [windowStartMs, windowEndMs] that placement must
 * schedule around (PR-C+, Workstream A — the shared "don't double-book" rule).
 *
 * Always obstacles: locked blocks, meetings, and every non-completed *task*
 * block — so Auto/pattern placement never stacks on existing work (manual or
 * auto) and pass 1's placements survive into pass 2. With `includePlans`, Plan
 * containers are obstacles too (the workday fallback flows *around* the Plans
 * the user drew, leaving their windows to their own tag-matched tasks).
 *
 * `excludeBlockId` drops one row (the Plan being filled) so a Plan isn't an
 * obstacle to placing inside itself.
 */
export function dayObstacles(
  windowStartMs: number,
  windowEndMs: number,
  opts: { includePlans?: boolean; excludeBlockId?: string | null } = {}
): { start: number; end: number }[] {
  const windowStartISO = new Date(windowStartMs).toISOString();
  const windowEndISO = new Date(windowEndMs).toISOString();
  const rows = sqlite
    .prepare(
      `SELECT id, start_at, end_at FROM time_blocks
        WHERE start_at < ? AND end_at > ?
          AND (
               is_locked = 1
            OR block_kind = 'meeting'
            OR (block_kind = 'task' AND status NOT IN ('completed','skipped','cancelled'))
            OR (? = 1 AND block_kind = 'timeblock' AND block_type = 'plan')
          )`
    )
    .all(windowEndISO, windowStartISO, opts.includePlans ? 1 : 0) as { id: string; start_at: string; end_at: string }[];
  return rows
    .filter((r) => r.id !== opts.excludeBlockId)
    .map((r) => ({ start: Date.parse(r.start_at), end: Date.parse(r.end_at) }));
}

/** Carve the workday into free windows between fixed events, with a break after each. */
export function buildGaps(
  dayStart: number,
  dayEnd: number,
  fixed: { start: number; end: number }[],
  breakMs: number
): Gap[] {
  const sorted = [...fixed].sort((a, b) => a.start - b.start);
  const gaps: Gap[] = [];
  let cursor = dayStart;

  for (const ev of sorted) {
    const gapEnd = Math.min(ev.start, dayEnd);
    if (cursor < gapEnd) gaps.push({ start: cursor, end: gapEnd, cursor });
    cursor = Math.max(cursor, ev.end + breakMs);
  }
  if (cursor < dayEnd) gaps.push({ start: cursor, end: dayEnd, cursor });
  return gaps;
}
