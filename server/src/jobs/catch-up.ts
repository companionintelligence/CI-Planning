// Boot-time catch-up for the learning passes.
//
// croner never re-fires a tick that fell while the process was not running: at start it works
// out the NEXT tick from the wall clock and nothing remembers the ones that went by. A server
// that is down at Monday 04:10 therefore skips that week's calibrations, and a correction made
// on Sunday is not applied until the Monday after. About a minute after boot this walks an
// allow-list of kinds, asks of each whether a tick of its cron fell after its last_run_at, and
// if so runs it once through `runScheduledJob`, the same path the cron takes, so the per-owner
// fan-out, the tick lock, job_runs rows, SSE and audit all come along unchanged.
//
// There is no periodic sweep, on purpose. croner caps every timer at 30 s and fires when the
// wall clock has reached the tick, then reschedules from the new clock. A process that survives
// a machine sleep therefore fires ONE late tick per kind within about 30 s of waking (checked
// with a patched Date across a 3 h jump over three hourly ticks: one fire, no replay). The only
// path that loses a tick outright is a process that was not running, which is what boot covers.
// A sweep would also run jobs in the middle of a session and could not tell a miss from a tick
// that was refused or errored, which is deliberately not a miss.
//
// WHO MAY BE CAUGHT UP. Only the kinds in CATCH_UP_KINDS, an explicit list. Nothing is derived
// from the cron period: reset_routines, freeze_stars, review_day, auto_schedule and
// generate_recurrences are all daily and differ in whether a late run is safe, and
// advance_objectives is weekly yet moves its own cadence. A derived rule would also make every
// new kind caught up by default, which is the unsafe default. Here a kind nobody has classified
// is never caught up, and the test over the seeded kinds fails until someone puts it in
// CATCH_UP_KINDS or gives it a reason in NOT_CAUGHT_UP. A kind belongs in the list when all
// four hold:
//   1. A run at 09:00 produces what the run at its tick would have: it rebuilds from durable
//      logs over a window anchored on `now`, or its writes are first-wins or keyed by date.
//   2. It writes only its own rollup and evidence tables (no tasks, time blocks, flight plan,
//      reminders, priorities or statuses) and calls no third party.
//   3. It is owner-scoped, so `runScheduledJob` fans it out per owner.
//   4. With the model down it leaves a gap, never a destructive downgrade. That is why
//      calibrate_dismissals reuses the vectors it already stored (by log_id, like
//      calibrate_classification): a run with the embedder down must not wipe them.
//
// WHAT last_run_at CAN AND CANNOT SAY. It is one value per KIND, and runJobInner is its only
// writer: the finish time of the last run by whichever owner finished last, set for done AND
// error runs and for manual runs, never for a run that was skipped or interrupted. So:
//   - a run that errored counts as attempted and is not retried, as a failed tick is not
//     retried today; a bug in a job cannot make it run again at every boot;
//   - a manual or "Run all" run by ONE owner after the missed tick makes the kind look current
//     for every owner, and a fan-out that died after owner A hides owner B. job_runs has no
//     owner column, and the Postgres schema is documented as frozen at 0147, so this is
//     written down rather than fixed;
//   - an interrupted run never reaches last_run_at, so its tick still looks missed and the kind
//     is tried again at the next boot, at most CATCH_UP_MAX_INTERRUPTED times, counted from the
//     rows failInterruptedJobRuns leaves behind;
//   - a null or future-dated value counts as "no record" and the kind runs once. Null has to
//     mean overdue because scheduled_jobs has no created_at: reading it as current would starve
//     a host that is never up at the tick. On a fresh install that is seven runs over empty
//     data, and the stamp it writes repairs a future-dated one.
// The first two fall back to what happens today (no run until the next tick). The third is a
// bounded retry, at most CATCH_UP_MAX_INTERRUPTED extra attempts. The fourth runs the kind once.

import { Cron } from 'croner';
import { store } from '../db/store.js';
import { logger } from '../lib/logger.js';
import { runScheduledJob, isScheduledJobBusy, INTERRUPTED_RUN_LOG } from './index.js';

/**
 * The kinds that are made up after downtime, in cron order: calibrate_estimates at 01:30, then
 * the Monday block by minute. Run one at a time in this order so the stagger the migrations
 * chose (the model kinds must not share a single GPU) holds here too.
 *
 * All seven are owner-scoped and none touches a table a person edits. Add a kind only if it
 * meets the four conditions in the header, and put a test beside it.
 */
export const CATCH_UP_KINDS = [
  'calibrate_estimates',
  'calibrate_triality',
  'calibrate_classification',
  'calibrate_dismissals',
  'calibrate_plan_loop',
  'snapshot_balance',
  'calibrate_placement',
] as const;

/**
 * Every other kind, and why a late run is not made up. Together with CATCH_UP_KINDS this has to
 * cover every seeded scheduled_jobs kind (a test checks), so a migration that seeds a job
 * cannot ship until somebody decides which side it is on. The reasons are the checked record
 * of why, not a to-do list; two are marked as candidates to move over.
 */
export const NOT_CAUGHT_UP: Readonly<Record<string, string>> = {
  reset_routines:
    'Flips every done Routine task back to open with no bound on when it was done, so at 09:00 it would reopen what the owner ticked this morning.',
  freeze_stars:
    "Freezes only yesterday, so older missed days stay gaps, and readers already compute an unfrozen day live. The client's offline op-log also sends held writes once the server answers, so a freeze just after boot could lock a day before they land.",
  review_day:
    "Defers every planned block that has already ended, so at 09:00 it would also defer this morning's blocks of someone who has just opened the app.",
  auto_schedule:
    'Marks every auto-placed block that ended today as skipped and re-stages it, which rewrites the day before the person has seen it.',
  nightly_grooming:
    'Moves every overdue task one priority step up on every run, promotes possibles and, for hands-off owners, places blocks. A second run is not the same as one, and the person sees the result.',
  generate_recurrences:
    'Safe to run late (keyed on the occurrence), left out on purpose: it is not a learning loop, and at boot it would create tasks the person sees and flag missed habits. First candidate to move over.',
  snapshot_db:
    'Safe to run late and time-independent, left out because it is not a learning loop. Backups are kept by count, so it would have to stay gated on a missed tick and never run at every boot. Second candidate to move over.',
  push_memory:
    'Watermarked, so the next tick pushes everything missed. When the memory service is unavailable or off it returns normally, which would record a run that pushed nothing and use up the catch-up.',
  prune_sync_events:
    'An age-based delete: a missed night loses nothing and the next tick prunes more.',
  enrich_tasks:
    'Fills blanks from memory and the model for up to 20 tasks per owner. It fixes itself at the next tick and would only add model and network load at boot.',
  advance_objectives:
    'Stamps last_advanced_at with the run time, so a mid-week catch-up makes the following Monday see less than a period and skip, and the next nomination lands a week later than the cadence says.',
  fire_reminders:
    'Runs every minute and claims every reminder that is due, so the first tick after boot already makes it up.',
  ingest_gmail:
    'Every 15 minutes, from a per-account watermark, so the first tick after boot covers the outage.',
  sync_calendar:
    'Every 15 minutes. It also places blocks and asks for a replan, and the next tick is at most 15 minutes away.',
  ingest_gcal:
    'Every 30 minutes, from a watermark. The next tick is at most 30 minutes away.',
  memory_suggest:
    'Every 6 hours, and idempotent on its source reference. The next tick covers it.',
  tag_tasks:
    'Hourly and state-based (it tags whatever is untagged), so the next tick covers it.',
  purge_objectives:
    'Hourly delete against an absolute deadline. The next tick does the same work.',
  promote_possibles:
    'No scheduled_jobs row since migration 0118 (nightly_grooming subsumes it) and runnable by hand only, so detection can never find it overdue. Listed so the registry stays complete.',
};

/** Boot to first look: the listener is up, the Ollama probe has settled and its 30 s cache has
 *  expired (so the readiness checks probe again), and a crash loop that restarts faster than
 *  this never gets here. The cron is armed first, so a real tick inside the wait runs as usual. */
export const CATCH_UP_DELAY_MS = 60_000;
/** A kind whose next real tick is this close (10 min) is left to it instead of running twice. */
export const CATCH_UP_IMMINENT_MS = 600_000;
/** How far last_run_at may sit ahead of now (5 min) and still be taken as a real stamp; further
 *  is a clock that ran ahead once, and is treated as no record. */
export const CATCH_UP_CLOCK_SKEW_MS = 300_000;
/** Interrupted attempts since the missed tick after which a kind waits for its next real tick.
 *  An interrupted run never reaches last_run_at, so without this a job that kills the process
 *  would be tried at every boot. */
export const CATCH_UP_MAX_INTERRUPTED = 2;

export type MissedReason = 'missed' | 'no-record';

export interface MissedTick {
  /** The latest scheduled tick before `now`, in server-local time like the cron itself. */
  tick: Date;
  reason: MissedReason;
}

/**
 * Did a tick of `cron` fall after `lastRunAt`? Pure: nothing is read or written.
 *
 * `tick` is the latest tick strictly before `now` (croner's previousRuns), so a boot that lands
 * on a tick's own second still sees the one before it and does not double with the cron's
 * fire. Built with no callback and no timezone option, the way startCronJobs reads the same
 * patterns: no timer is created, and ticks are in server-local time. In the hour a DST change
 * skips, croner can hand back a tick that is still ahead of `now`; that is not a missed tick,
 * so it returns null and the cron has it.
 *
 * An unparsable lastRunAt, a null one, or one more than CATCH_UP_CLOCK_SKEW_MS ahead of `now`
 * is reported as 'no-record' rather than given a made-up tick. A cron croner cannot parse, or
 * cannot walk back from (an impossible date such as Feb 31 throws from previousRuns, not from
 * the constructor), returns null: that job has no schedule to have missed.
 */
export function missedTick(cron: string, lastRunAt: string | null, now: Date): MissedTick | null {
  let tick: Date | undefined;
  try {
    tick = new Cron(cron).previousRuns(1, now)[0];
  } catch {
    return null;
  }
  if (!tick || tick.getTime() >= now.getTime()) return null;

  const last = lastRunAt == null ? NaN : Date.parse(lastRunAt);
  if (!Number.isFinite(last) || last > now.getTime() + CATCH_UP_CLOCK_SKEW_MS) {
    return { tick, reason: 'no-record' };
  }
  return last < tick.getTime() ? { tick, reason: 'missed' } : null;
}

/** Milliseconds from `now` to the next tick of `cron`, or null if it has none or cannot be parsed. */
export function msUntilNextTick(cron: string, now: Date): number | null {
  try {
    const next = new Cron(cron).nextRun(now);
    return next ? next.getTime() - now.getTime() : null;
  } catch {
    return null;
  }
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * What goes in front of a caught-up run's log in the Jobs view. The missed tick is written in
 * server-local time, the zone croner fired it in; with no record there is no tick to name, so
 * it says that instead of inventing one.
 */
export function catchUpLogPrefix(m: MissedTick): string {
  if (m.reason === 'no-record') return 'Caught up (no earlier run recorded) — ';
  const t = m.tick;
  const stamp = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;
  return `Caught up (missed ${stamp}) — `;
}

/**
 * One pass over CATCH_UP_KINDS. Returns the kinds it started, in order. Never rejects: any
 * failure is logged and the pass moves on, so a problem here cannot reach boot.
 *
 * Strictly one kind at a time. Each kind is looked at once, with its row and the clock read
 * fresh, so a real tick or a manual run that landed meanwhile has already satisfied it. A real
 * tick of ANOTHER kind can overlap, just as ticks overlap today.
 */
export async function runCatchUp(opts: { signal?: AbortSignal } = {}): Promise<string[]> {
  const started: string[] = [];

  for (const kind of CATCH_UP_KINDS) {
    try {
      // Checked before each kind: once a shutdown has begun no further kind starts. The kind
      // already running is cut with the process like any other job, and counts as interrupted.
      if (opts.signal?.aborted) break;

      // Same predicate as startCronJobs: disabling a job row stops its cron and its catch-up.
      // `name` is unique and `kind` is not, so if two rows share a kind take the first.
      const job = await store()
        .prepare('SELECT cron, last_run_at FROM scheduled_jobs WHERE kind = ? AND enabled = 1 ORDER BY name LIMIT 1')
        .get<{ cron: string; last_run_at: string | null }>(kind);
      if (!job) continue;

      const now = new Date();
      const missed = missedTick(job.cron, job.last_run_at, now);
      if (!missed) {
        logger.debug('Catch-up: nothing overdue', { kind });
        continue;
      }

      // Boots a few minutes before a tick are common (a restart, a deploy); that tick covers it.
      const wait = msUntilNextTick(job.cron, now);
      if (wait !== null && wait <= CATCH_UP_IMMINENT_MS) {
        logger.debug('Catch-up: next tick is close, leaving it to the cron', { kind, inMs: wait });
        continue;
      }

      // Counted from job_runs because last_run_at never records an interrupted run. started_at
      // is always the ISO string runJobInner wrote, so comparing strings is comparing instants.
      const interrupted = await store()
        .prepare(
          `SELECT COUNT(*) AS n FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
            WHERE j.kind = ? AND r.status = 'error' AND r.log = ? AND r.started_at >= ?`,
        )
        .get<{ n: number }>(kind, INTERRUPTED_RUN_LOG, missed.tick.toISOString());
      const interruptedCount = Number(interrupted?.n ?? 0);
      if (interruptedCount >= CATCH_UP_MAX_INTERRUPTED) {
        logger.warn(`Catch-up: skipped, interrupted ${interruptedCount} times since the missed tick`, { kind });
        continue;
      }

      // No await between this check and the call: a real tick that holds the lock is left to
      // finish (quietly, not through runScheduledJob's refusal warning), and none can slip in
      // between the two.
      if (isScheduledJobBusy(kind)) {
        logger.debug('Catch-up: a scheduled run of this kind is going, skipped', { kind });
        continue;
      }

      logger.info('Catch-up: running a missed job', {
        kind,
        tick: missed.tick.toISOString(),
        lastRunAt: job.last_run_at,
      });
      started.push(kind);
      await runScheduledJob(kind, { logPrefix: catchUpLogPrefix(missed) });
    } catch (err) {
      logger.warn('Catch-up failed', { kind, err: err instanceof Error ? err.message : String(err) });
    }
  }

  if (started.length > 0) logger.info('Catch-up finished', { started });
  return started;
}

// The armed timer and the controller its pass listens to. Kept after the timer has fired, so a
// shutdown during the pass can still tell it to stop.
let pending: { timer: NodeJS.Timeout; controller: AbortController } | null = null;

/**
 * Arm the one boot-time pass. Unref'd, so it never keeps the process alive. A second call
 * replaces the first rather than leaving two passes armed. `run` and `delayMs` are there for
 * tests.
 *
 * The callback must not let a rejection escape: nothing in src handles `unhandledRejection`,
 * and Node would take the whole server down with it.
 */
export function scheduleCatchUp(
  run: (signal: AbortSignal) => Promise<unknown> = (signal) => runCatchUp({ signal }),
  delayMs: number = CATCH_UP_DELAY_MS,
): NodeJS.Timeout {
  cancelCatchUp();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    void run(controller.signal).catch((err) => {
      logger.warn('Catch-up failed', { err: err instanceof Error ? err.message : String(err) });
    });
  }, delayMs);
  timer.unref();
  pending = { timer, controller };
  return timer;
}

/** Called on SIGTERM/SIGINT, ahead of server.close: a pass not yet started never starts, and one
 *  under way starts no further kind. A kind already running is not stopped; the process exits
 *  with it, like any other job, and the next boot counts it as interrupted. */
export function cancelCatchUp(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.controller.abort();
  pending = null;
}
