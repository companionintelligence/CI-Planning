/**
 * Recurrence generation job (Phase E, PR-2).
 *
 * Materializes concrete task *instances* from recurrence *templates* on a bounded,
 * rolling horizon, and flags missed habit instances. The two load-bearing
 * invariants (the scale-budget contract):
 *   - **Bounded:** only `[today, today+HORIZON_DAYS]` is ever materialized, capped
 *     per template. The table can't grow with wall-clock time — old instances age
 *     out as completed/skipped/missed history; new ones appear only as the window
 *     rolls.
 *   - **Idempotent:** `INSERT OR IGNORE` against the `ux_task_occurrence` unique
 *     index makes a second run in the same window insert zero rows. No "have we
 *     generated this?" bookkeeping.
 *
 * Determinism: the only clock read is `today` (defaulted once, or threaded in by
 * tests). Pattern math lives in `recurrence.ts` (rrule.js); every wall-clock→UTC
 * instant goes through `lib/tz.ts`.
 *
 * Instance roles & scheduler interaction:
 *   - A *template* (`recurrence_rule` set, `recurrence_parent_id` null) is never
 *     scheduled directly. We mark any still-`open` template `recurring` so the
 *     scheduler's `status='open'` today-set skips it with no scheduler edit.
 *   - An *instance* is a plain `open` task gated to its occurrence day via
 *     `defer_until` (the scheduler's `ready` filter drops `deferUntil >= dayHi`),
 *     so future-window instances don't flood today. A timed instance also carries
 *     `task_time` + a same-day `due_at`, which the scheduler pins as an appointment.
 */
import { sqlite } from '../db/index.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { localISODate } from '../lib/dates.js';
import { serverTimezone, utcDayBounds } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { occurrencesBetween, instanceStartUTC, type Template } from './recurrence.js';
import { syncTaskReminders } from './reminders.js';

/** Bounded rolling window (days) — the scale-budget cap. */
export const HORIZON_DAYS = 14;
/** Hard ceiling per template per run — defense in depth against a runaway rule. */
const MAX_PER_TEMPLATE = 60;

export interface GenerateResult {
  /** New instances materialized this run. */
  created: number;
  /** Habit instances newly flagged `missed` this run. */
  missed: number;
  /** Templates processed. */
  templates: number;
}

interface TemplateRow {
  id: string;
  title: string;
  task_time: string | null;
  estimated_minutes: number | null;
  priority: number | null;
  status: string;
  owner_id: string;
  is_habit: number;
  subtype: string | null;
  recurrence_rule: string;
  recurrence_dtstart: string | null;
  recurrence_exdates: string | null;
}

/** Add `n` calendar days to a YYYY-MM-DD. Date-only UTC arithmetic — no tz/DST. */
function addDaysISO(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Owner's planning timezone, falling back to the server zone. */
export function ownerTimezone(owner: string): string {
  const row = sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as
    | { timezone: string | null }
    | undefined;
  return row?.timezone || serverTimezone();
}

/** Parse the stored EXDATE JSON (`string[]`), tolerating null/garbage. */
function parseExdates(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Flag missed habit instances for one template: a habit instance whose occurrence
 * day is strictly before `today` and is still `open` becomes `missed` — a
 * broken-streak marker the client surfaces (Phase H later turns it into a
 * notification). Returns the count flagged. Idempotent (only touches `open` rows).
 */
export function flagMissedHabits(templateId: string, today: string): number {
  return sqlite
    .prepare(
      `UPDATE tasks SET status = 'missed'
        WHERE recurrence_parent_id = ? AND subtype = 'habit' AND status = 'open'
          AND occurrence_date IS NOT NULL AND occurrence_date < ?`
    )
    .run(templateId, today).changes;
}

/**
 * Materialize upcoming instances for every recurrence template owned by the
 * current owner, and flag missed habits. Bounded + idempotent (see file header).
 *
 * @param opts.today      Local YYYY-MM-DD anchor (defaults to the local date now).
 * @param opts.horizonDays Window size in days (defaults to {@link HORIZON_DAYS}).
 */
export function generateRecurrences(opts: { today?: string; horizonDays?: number } = {}): GenerateResult {
  const owner = currentOwnerId();
  const tz = ownerTimezone(owner);
  const today = opts.today ?? localISODate();
  const horizon = addDaysISO(today, opts.horizonDays ?? HORIZON_DAYS);

  const templates = sqlite
    .prepare(
      `SELECT id, title, task_time, estimated_minutes, priority, status, owner_id, is_habit, subtype,
              recurrence_rule, recurrence_dtstart, recurrence_exdates
         FROM tasks
        WHERE recurrence_rule IS NOT NULL AND recurrence_parent_id IS NULL
          AND status NOT IN ('cancelled') AND owner_id = ?`
    )
    .all(owner) as TemplateRow[];

  // Keep templates out of the scheduler's today-set (it filters status='open').
  const markRecurring = sqlite.prepare(`UPDATE tasks SET status = 'recurring' WHERE id = ? AND status = 'open'`);

  const ins = sqlite.prepare(
    `INSERT OR IGNORE INTO tasks
       (id, title, scheduled_for, defer_until, task_time, due_at, estimated_minutes, priority,
        status, owner_id, recurrence_parent_id, occurrence_date, is_habit, subtype, source_kind)
     VALUES (uuid7(), @title, @sched, @defer, @time, @due, @est, @prio,
             'open', @owner, @parent, @day, @habit, @subtype, 'recurrence')
     RETURNING id`
  );

  let created = 0;
  let missed = 0;

  for (const t of templates) {
    markRecurring.run(t.id);

    const template: Template = {
      recurrenceRule: t.recurrence_rule,
      // A template should always have a dtstart (set at create time); fall back to
      // today's start so a malformed/legacy row still anchors somewhere sensible.
      recurrenceDtstart: t.recurrence_dtstart ?? utcDayBounds(today, tz).start,
      taskTime: t.task_time,
      recurrenceExdates: parseExdates(t.recurrence_exdates),
      timezone: tz,
    };

    let days: string[];
    try {
      days = occurrencesBetween(template, today, horizon).slice(0, MAX_PER_TEMPLATE);
    } catch (err) {
      // A malformed stored rule must never fail the whole run — log + skip it.
      logger.warn('recurrence.skip_template', { id: t.id, err: (err as Error).message });
      continue;
    }

    for (const day of days) {
      const row = ins.get({
        title: t.title,
        sched: day, // intent to work it that day
        defer: utcDayBounds(day, tz).start, // gates the instance to its occurrence day
        time: t.task_time,
        due: t.task_time ? instanceStartUTC(day, t.task_time, tz) : null, // pin timed instances
        est: t.estimated_minutes,
        prio: t.priority,
        owner: t.owner_id,
        parent: t.id,
        day,
        habit: t.is_habit,
        // Propagate the template's canonical subtype to each instance (CON-2c). Without
        // this every generated instance fell back to the column default 'standard', so a
        // habit template produced is_habit=1 / subtype='standard' instances — incoherent,
        // and streamed to clients over SSE. Backfill 0042 corrects rows generated before this.
        subtype: t.subtype ?? 'standard',
      }) as { id: string } | undefined;
      // INSERT OR IGNORE → no row when the slot already exists, so this runs ONCE per
      // instance. A newly materialized instance derives its reminders from the owner's
      // Reminder Defaults (Phase H b) — anchored on its occurrence start (task_time).
      if (row) {
        created++;
        syncTaskReminders(t.owner_id, row.id);
      }
    }

    if (t.subtype === 'habit') missed += flagMissedHabits(t.id, today);
  }

  broadcast(owner, 'recurrence:generated', { created, missed, templates: templates.length });
  logger.info('recurrence.generated', { created, missed, templates: templates.length, today, horizon });
  return { created, missed, templates: templates.length };
}
