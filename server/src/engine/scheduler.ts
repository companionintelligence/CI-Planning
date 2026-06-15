import { eq, asc } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, timeBlocks, schedulingPrefs } from '../db/schema.js';
import type { InferSelectModel } from 'drizzle-orm';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { serverTimezone, zonedWallTimeToUTC, utcDayBounds } from '../lib/tz.js';
import { orderForToday } from '../agents/plan.js';

type Task = InferSelectModel<typeof tasks>;

export interface ScheduleResult {
  date: string;
  blocksCreated: number;
  blocksRemoved: number;
  tasksScheduled: number;     // every focus session placed
  partiallyScheduled: number; // some sessions placed, capacity ran out
  unscheduled: number;        // selected for today but nothing fit
  deferred: number;           // left in the backlog for a future day (rolling horizon)
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
// Cap how many tasks the (optional) LLM ordering pass sees, to bound the prompt.
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

  // ── Selection: build the "today set", roll the rest over ──────────────────────
  const openTasks = (await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'open'))
    .orderBy(asc(tasks.priority), asc(tasks.dueAt), asc(tasks.id))) as Task[];

  // A dated task is only eligible if its deadline is within the horizon; undated
  // tasks are always eligible as backlog fill. Far-future dated tasks roll over.
  const horizonDays = Math.max(1, prefs.planningHorizonDays ?? 3);
  const horizonCutoffISO = utcDayBounds(addLocalDays(date, horizonDays - 1), tz).end;
  const eligible = openTasks.filter((t) => !t.dueAt || t.dueAt < horizonCutoffISO);
  let deferred = openTasks.length - eligible.length;

  // Most urgent first: overdue, then priority, then deadline, then id (stable).
  const overdue = (t: Task) => (t.dueAt && t.dueAt < dayLoISO ? 0 : 1);
  const ranked = [...eligible].sort(
    (a, b) =>
      overdue(a) - overdue(b) ||
      (a.priority ?? 3) - (b.priority ?? 3) ||
      (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') ||
      a.id - b.id
  );

  // Optional AI pass (planning_mode === 'auto'): let the model reorder the head of
  // the list. Placement stays deterministic; falls back to `ranked` if it can't.
  const ordered = await orderForToday(ranked.slice(0, AI_ORDER_LIMIT), prefs).then((head) => [
    ...head,
    ...ranked.slice(AI_ORDER_LIMIT),
  ]);

  // Fixed-time tasks (a pinned start time-of-day) are appointments: place them
  // first at their local time and let everything else pack around them.
  const pinned = ordered.filter((t) => !!t.taskTime);
  const flexible = ordered.filter((t) => !t.taskTime);

  let blocksCreated = 0;
  let tasksScheduled = 0;
  let partiallyScheduled = 0;
  let unscheduled = 0;

  for (const task of pinned) {
    const startMs = new Date(zonedWallTimeToUTC(date, normalizeTime(task.taskTime!), tz)).getTime();
    const endMs = startMs + (task.estimatedMinutes ?? 30) * MS_PER_MIN;
    await insertBlock(task, task.title, startMs, endMs);
    fixed.push({ start: startMs, end: endMs }); // carve it out of the day for the packer
    blocksCreated++;
    tasksScheduled++;
  }

  const gaps = buildGaps(dayStartMs, dayEndMs, fixed, breakMs);

  // Capacity-bound the flexible set: take tasks in order until their estimates
  // fill the day. The rest roll over instead of being force-fit and reported as
  // "unscheduled".
  let capacityMs = gaps.reduce((sum, g) => sum + (g.end - g.cursor), 0);
  const todaySet: Task[] = [];
  for (const t of flexible) {
    if (capacityMs <= 0) break;
    todaySet.push(t);
    capacityMs -= (t.estimatedMinutes ?? 30) * MS_PER_MIN;
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
      await insertBlock(task, total > 1 ? `${task.title} (${placed + 1}/${total})` : task.title, startMs, endMs);
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

  broadcast('schedule:done', result);
  logger.info('scheduler.done', result);
  return result;
}

async function insertBlock(task: Task, title: string, startMs: number, endMs: number): Promise<void> {
  await db.insert(timeBlocks).values({
    taskId: task.id,
    title,
    blockKind: 'task',
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    isAuto: true,
    isLocked: false,
    sourceKind: 'agent',
    status: 'planned',
  });
}

/** "9:5" / "9:05" → "09:05"; tolerate sloppy stored times. */
function normalizeTime(t: string): string {
  const [h, m] = t.split(':');
  return `${String(Number(h)).padStart(2, '0')}:${String(Number(m ?? 0)).padStart(2, '0')}`;
}

/** Add `n` calendar days to a YYYY-MM-DD string (UTC-noon pivot is DST-safe). */
function addLocalDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
 * Choose where a session of `wantMs` goes: the *earliest* gap that fits it fully
 * (first-fit by time, so the day stays front-loaded); otherwise the earliest gap
 * that can hold a usable partial session. Gaps are in chronological order, and
 * every task scans from the start — so a smaller task still backfills an early
 * hole a bigger task had to skip.
 */
function pickGap(gaps: Gap[], wantMs: number): { gap: Gap; len: number } | null {
  for (const g of gaps) {
    if (g.end - g.cursor >= wantMs) return { gap: g, len: wantMs };
  }
  for (const g of gaps) {
    const free = g.end - g.cursor;
    if (free >= MIN_SESSION_MS) return { gap: g, len: free };
  }
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
