import Router from '@koa/router';
import { summarizeDay, morningCarryover } from '../agents/summarize.js';
import { localISODate, isValidISODate } from '../lib/dates.js';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { serverTimezone, utcDayBounds } from '../lib/tz.js';
import { timeSenseEnabled } from '../lib/flags.js';

/** One row in the Today's Brief "Top tasks" list (Phase O · O0). */
export interface TopTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  planned: boolean;   // in the day's frozen daily_plan
  done: boolean;
}

/**
 * The Today's Brief "Top tasks" list: real, plannable Tasks for the day, ranked
 * by the frozen `daily_plan` order then priority. EXCLUDES habits (subtype='habit')
 * and routine/pattern instances (a task in pattern_tasks, or a recurring instance
 * — recurrence_parent_id set) — habits/routines are never "top tasks" (mirrors the
 * S3/S4 star rule). A task counts as "for the day" when it is in the day's
 * daily_plan OR has a time-block placed within the local day.
 */
export async function topTasksForDay(date: string): Promise<TopTask[]> {
  const owner = currentOwnerId();
  const tzRow = await store()
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get<{ timezone: string | null }>(owner);
  const tz = tzRow?.timezone || serverTimezone();
  const { start: dayStart, end: dayEnd } = utcDayBounds(date, tz);

  const rows = await store()
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority,
              (dp.task_id IS NOT NULL) AS planned,
              dp.position AS plan_pos
         FROM tasks t
         LEFT JOIN daily_plan dp
           ON dp.task_id = t.id AND dp.owner_id = ? AND dp.date = ?
        WHERE t.owner_id = ?
          AND t.status NOT IN ('cancelled', 'recurring', 'skipped')
          -- exclude habits (their own star) and routine/pattern instances
          AND COALESCE(t.subtype, 'standard') != 'habit'
          AND t.recurrence_parent_id IS NULL
          AND t.id NOT IN (SELECT task_id FROM pattern_tasks)
          -- "for the day": planned in daily_plan OR has a block placed today
          AND (
            dp.task_id IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM time_blocks tb
               WHERE tb.task_id = t.id AND tb.owner_id = t.owner_id AND tb.start_at >= ? AND tb.start_at < ?
            )
          )
        ORDER BY (dp.position IS NULL), dp.position ASC, t.priority ASC, t.id ASC`,
    )
    .all<{
      id: string; title: string; status: string; priority: number; planned: number; plan_pos: number | null;
    }>(owner, date, owner, dayStart, dayEnd);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    planned: !!r.planned,
    done: r.status === 'done',
  }));
}

export function summaryRouter() {
  const router = new Router();

  // GET /api/summary?date=YYYY-MM-DD&refresh=1
  router.get('/api/summary', async (ctx) => {
    const { date, refresh } = ctx.query as Record<string, string>;
    const day = date ?? localISODate();
    const summary = await summarizeDay(day, { refresh: refresh === '1' || refresh === 'true' });
    // Z2: fold last night's EOD Alignment into the morning Brief (flag-gated,
    // computed outside the cache so it's always fresh). Absent → field omitted.
    const evening = timeSenseEnabled(currentOwnerId()) ? morningCarryover(day) : undefined;
    ctx.body = evening ? { ...summary, evening } : summary;
  });

  // GET /api/summary/top-tasks?date=YYYY-MM-DD — the Today's Brief top-tasks list
  // (Phase O · O0). Non-habit, non-routine tasks for the day, daily_plan-ranked.
  router.get('/api/summary/top-tasks', async (ctx) => {
    const raw = (ctx.query as Record<string, unknown>).date;
    if (raw !== undefined && !isValidISODate(raw)) {
      ctx.status = 422;
      ctx.body = { error: 'date must be YYYY-MM-DD' };
      return;
    }

    const day = typeof raw === 'string' ? raw : localISODate();
    ctx.body = { tasks: await topTasksForDay(day) };
  });

  return router;
}
