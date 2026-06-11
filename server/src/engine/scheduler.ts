import { and, eq, isNull, lte, asc } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, timeBlocks, schedulingPrefs, habits } from '../db/schema.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';

export interface ScheduleResult {
  date: string;
  blocksCreated: number;
  blocksRemoved: number;
  unscheduled: number;
}

export async function runScheduler(date: string): Promise<ScheduleResult> {
  logger.info('scheduler.run', { date });

  const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, 1));
  if (!prefs) return { date, blocksCreated: 0, blocksRemoved: 0, unscheduled: 0 };

  const dayStart = `${date}T${prefs.workdayStart}:00.000Z`;
  const dayEnd   = `${date}T${prefs.workdayEnd}:00.000Z`;

  // Remove auto blocks for the day that are not locked/completed
  const removed = sqlite
    .prepare(
      `DELETE FROM time_blocks
       WHERE start_at >= ? AND start_at < ? AND is_auto = 1 AND is_locked = 0
         AND status NOT IN ('completed', 'skipped')
       RETURNING id`
    )
    .all(dayStart, `${date}T23:59:59.000Z`) as { id: number }[];

  // Load fixed events (locked blocks + meetings)
  const fixed = (sqlite
    .prepare(
      `SELECT start_at, end_at FROM time_blocks
       WHERE start_at >= ? AND end_at <= ? AND (is_locked = 1 OR block_kind = 'meeting')`
    )
    .all(dayStart, dayEnd) as { start_at: string; end_at: string }[])
    .map((r) => ({ start: new Date(r.start_at).getTime(), end: new Date(r.end_at).getTime() }));

  let currentOccupied = [...fixed].sort((a, b) => a.start - b.start);
  let blocksCreated = 0;

  // Load enabled habits
  const allHabits = await db.select().from(habits).where(eq(habits.enabled, true));
  const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();
  const activeHabits = allHabits.filter(h => {
    const days = (h.daysOfWeek ?? '1,2,3,4,5').split(',').map(Number);
    return days.includes(dayOfWeek);
  });

  // Schedule habits first in their flexible windows
  for (const habit of activeHabits) {
    const gaps = buildGaps(
      new Date(dayStart).getTime(),
      new Date(dayEnd).getTime(),
      currentOccupied,
      prefs.minBreakMinutes ?? 10
    );

    const D = habit.durationMinutes * 60_000;
    const earliestTime = new Date(`${date}T${habit.startTimeEarliest}:00.000Z`).getTime();
    const latestTime = new Date(`${date}T${habit.startTimeLatest}:00.000Z`).getTime();

    let scheduledStart: number | null = null;
    for (const gap of gaps) {
      const startCandidate = Math.max(gap.start, earliestTime);
      const endCandidate = startCandidate + D;
      if (startCandidate <= latestTime && endCandidate <= gap.end) {
        scheduledStart = startCandidate;
        break;
      }
    }

    if (scheduledStart !== null) {
      const scheduledEnd = scheduledStart + D;
      await db.insert(timeBlocks).values({
        title: habit.title,
        blockKind: 'habit',
        startAt: new Date(scheduledStart).toISOString(),
        endAt: new Date(scheduledEnd).toISOString(),
        isAuto: true,
        isLocked: false,
        sourceKind: 'agent',
        status: 'planned',
      });
      blocksCreated++;
      currentOccupied.push({ start: scheduledStart, end: scheduledEnd });
      currentOccupied.sort((a, b) => a.start - b.start);
    }
  }

  // Build free gaps for task scheduling
  const finalGaps = buildGaps(
    new Date(dayStart).getTime(),
    new Date(dayEnd).getTime(),
    currentOccupied,
    prefs.minBreakMinutes ?? 10
  );

  // Load backlog (open tasks without a completed block for this day)
  const backlog = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'open')))
    .orderBy(asc(tasks.priority), asc(tasks.dueAt));

  let gapIdx = 0;
  const unscheduled: number[] = [];
  const maxFocus = (prefs.maxFocusBlockMinutes ?? 90) * 60_000;

  for (const task of backlog) {
    const needed = (task.estimatedMinutes ?? 30) * 60_000;

    // Find a gap that fits
    while (gapIdx < finalGaps.length && finalGaps[gapIdx].end - finalGaps[gapIdx].start < Math.min(needed, maxFocus)) {
      gapIdx++;
    }

    if (gapIdx >= finalGaps.length) {
      unscheduled.push(task.id);
      continue;
    }

    const gap = finalGaps[gapIdx];
    const blockEnd = Math.min(gap.start + needed, gap.start + maxFocus, gap.end);

    await db.insert(timeBlocks).values({
      taskId: task.id,
      title: task.title,
      blockKind: 'task',
      startAt: new Date(gap.start).toISOString(),
      endAt: new Date(blockEnd).toISOString(),
      isAuto: true,
      isLocked: false,
      sourceKind: 'agent',
      status: 'planned',
    });

    blocksCreated++;
    gap.start = blockEnd + (prefs.minBreakMinutes ?? 10) * 60_000;
  }

  const result: ScheduleResult = {
    date,
    blocksCreated,
    blocksRemoved: removed.length,
    unscheduled: unscheduled.length,
  };

  broadcast('schedule:done', result);
  logger.info('scheduler.done', result);
  return result;
}

function buildGaps(
  dayStart: number,
  dayEnd: number,
  fixed: { start: number; end: number }[],
  breakMinutes: number
): { start: number; end: number }[] {
  const sorted = [...fixed].sort((a, b) => a.start - b.start);
  const gaps: { start: number; end: number }[] = [];
  let cursor = dayStart;
  const breakMs = breakMinutes * 60_000;

  for (const event of sorted) {
    if (cursor < event.start) gaps.push({ start: cursor, end: event.start });
    cursor = Math.max(cursor, event.end + breakMs);
  }

  if (cursor < dayEnd) gaps.push({ start: cursor, end: dayEnd });
  return gaps;
}
