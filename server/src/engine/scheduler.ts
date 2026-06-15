import { and, eq, asc } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, timeBlocks, schedulingPrefs } from '../db/schema.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { serverTimezone, zonedWallTimeToUTC, utcDayBounds } from '../lib/tz.js';

export interface ScheduleResult {
  date: string;
  blocksCreated: number;
  blocksRemoved: number;
  tasksScheduled: number;     // every focus session placed
  partiallyScheduled: number; // some sessions placed, capacity ran out
  unscheduled: number;        // nothing fit
}

/** A free window in the day, with a moving cursor as blocks are packed in. */
interface Gap {
  start: number;
  end: number;
  cursor: number;
}

const MS_PER_MIN = 60_000;
// Don't carve a focus block shorter than this — sub-quarter-hour slivers aren't useful.
const MIN_SESSION_MS = 15 * MS_PER_MIN;

export async function runScheduler(date: string): Promise<ScheduleResult> {
  logger.info('scheduler.run', { date });

  const empty: ScheduleResult = {
    date,
    blocksCreated: 0,
    blocksRemoved: 0,
    tasksScheduled: 0,
    partiallyScheduled: 0,
    unscheduled: 0,
  };

  const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, 1));
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
    .all(dayLoISO, dayHiISO) as { id: number }[];

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

  const gaps = buildGaps(dayStartMs, dayEndMs, fixed, breakMs);

  // Backlog, most urgent first. (Nulls sort first in SQLite ASC — undated before dated.)
  const backlog = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'open')))
    .orderBy(asc(tasks.priority), asc(tasks.dueAt), asc(tasks.id));

  let blocksCreated = 0;
  let tasksScheduled = 0;
  let partiallyScheduled = 0;
  let unscheduled = 0;

  for (const task of backlog) {
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
  };

  broadcast('schedule:done', result);
  logger.info('scheduler.done', result);
  return result;
}

/** Split a duration into focus-sized sessions; the final session may be shorter. */
function splitIntoSessions(totalMs: number, maxFocusMs: number): number[] {
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
function pickGap(gaps: Gap[], wantMs: number): { gap: Gap; len: number } | null {
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

/** Carve the workday into free windows between fixed events, with a break after each. */
function buildGaps(
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
