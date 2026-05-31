import { and, eq, isNull, lte, asc } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, timeBlocks, schedulingPrefs } from '../db/schema.js';
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

  // Build free gaps
  const gaps = buildGaps(
    new Date(dayStart).getTime(),
    new Date(dayEnd).getTime(),
    fixed,
    prefs.minBreakMinutes ?? 10
  );

  // Load backlog (open tasks without a completed block for this day)
  const backlog = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'open')))
    .orderBy(asc(tasks.priority), asc(tasks.dueAt));

  let gapIdx = 0;
  let blocksCreated = 0;
  const unscheduled: number[] = [];
  const maxFocus = (prefs.maxFocusBlockMinutes ?? 90) * 60_000;

  for (const task of backlog) {
    const needed = (task.estimatedMinutes ?? 30) * 60_000;

    // Find a gap that fits
    while (gapIdx < gaps.length && gaps[gapIdx].end - gaps[gapIdx].start < Math.min(needed, maxFocus)) {
      gapIdx++;
    }

    if (gapIdx >= gaps.length) {
      unscheduled.push(task.id);
      continue;
    }

    const gap = gaps[gapIdx];
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
