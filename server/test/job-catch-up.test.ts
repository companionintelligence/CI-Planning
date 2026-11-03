import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Cron } from 'croner';
import { sqlite } from '../src/db/index.js';
import { store } from '../src/db/store.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { logger } from '../src/lib/logger.js';
import {
  runJob,
  runScheduledJob,
  failInterruptedJobRuns,
  INTERRUPTED_RUN_LOG,
} from '../src/jobs/index.js';
import {
  CATCH_UP_KINDS,
  NOT_CAUGHT_UP,
  CATCH_UP_DELAY_MS,
  CATCH_UP_IMMINENT_MS,
  CATCH_UP_CLOCK_SKEW_MS,
  CATCH_UP_MAX_INTERRUPTED,
  missedTick,
  msUntilNextTick,
  catchUpLogPrefix,
  runCatchUp,
  scheduleCatchUp,
  cancelCatchUp,
} from '../src/jobs/catch-up.js';
import { resetRoutineTasks } from '../src/jobs/reset-routines.js';
import { reviewAndReschedule } from '../src/engine/review.js';
import { surfaceOverdue } from '../src/agents/groom.js';
import { resetDb, createOwner, SECOND_OWNER_ID } from './helpers.js';

/**
 * Boot-time catch-up (jobs/catch-up.ts). croner never re-fires a tick that fell while the
 * server was down, so a few learning passes are made up once, about a minute after the next
 * start, when a tick of their cron fell after scheduled_jobs.last_run_at.
 *
 * Every Date below is built from LOCAL components. The patterns are read in server-local time
 * (the same as startCronJobs, no timezone option), so a fixed UTC instant would land on a
 * different wall-clock time under another TZ and change which tick is the latest one. The
 * DB-backed tests fake Date and nothing else, so detection and the stamps runJobInner writes
 * share one clock while promises and setImmediate keep running for real.
 *
 * resetDb() keeps scheduled_jobs, and other files' runJob calls stamp last_run_at on those
 * shared rows, so each DB test sets last_run_at and enabled itself and puts them back after.
 */

// Pinned to a zone that is neither UTC nor fixed-offset. A runner in UTC (CI is) would otherwise
// make local and UTC the same and hide a ticks-in-UTC or UTC-getters mistake. Set before any
// Date below is built, and put back after the file.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** A Date from local components, month 1-based. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s, ms);
const iso = (d: Date): string => d.toISOString();

/** A Wednesday: this week's daily 01:30 and the Monday block have all fallen already. */
const WED = local(2026, 11, 4, 9, 0);
/** Older than every tick the tests look back to, so a kind stamped with it is overdue. */
const STALE = iso(local(2026, 10, 20, 12, 0));

type CatchUpKind = (typeof CATCH_UP_KINDS)[number];
const KINDS: readonly string[] = CATCH_UP_KINDS;
/**
 * The seven, in the order their crons first fire in a week. Written out here, not read from the
 * tuple, so that a test comparing against it can tell a reshuffled or trimmed tuple from a
 * correct one; a test that compared the tuple with itself could not.
 */
const SEVEN = [
  'calibrate_estimates',
  'calibrate_triality',
  'calibrate_classification',
  'calibrate_dismissals',
  'calibrate_plan_loop',
  'snapshot_balance',
  'calibrate_placement',
] as const;

/** What WED sees as each kind's latest tick, local, as the Jobs view prints it. */
const WED_TICK: Record<CatchUpKind, string> = {
  calibrate_estimates: '2026-11-04 01:30',
  calibrate_triality: '2026-11-02 03:50',
  calibrate_classification: '2026-11-02 04:10',
  calibrate_dismissals: '2026-11-02 04:20',
  calibrate_plan_loop: '2026-11-02 04:30',
  snapshot_balance: '2026-11-02 04:40',
  calibrate_placement: '2026-11-02 04:50',
};

// ── missedTick / msUntilNextTick / catchUpLogPrefix: pure ────────────────────────────

describe('missedTick', () => {
  const PLACEMENT = '50 4 * * 1'; // Mondays 04:50

  it('runs under the zone the file pins, or the local-time checks below prove nothing', () => {
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).toBe(480); // PST
    expect(new Date(2026, 6, 15, 12).getTimezoneOffset()).toBe(420); // PDT
  });

  it('names the latest tick, as no-record, when nothing was ever recorded', () => {
    const m = missedTick(PLACEMENT, null, WED);
    expect(m).toEqual({ tick: local(2026, 11, 2, 4, 50), reason: 'no-record' });
  });

  it('is null when the run finished seconds after the tick (ran Monday, restarted at 08:00)', () => {
    // last_run_at is the FINISH time, so a run that started on the tick ends a little later.
    const now = local(2026, 11, 2, 8, 0);
    expect(missedTick('10 4 * * 1', iso(local(2026, 11, 2, 4, 10, 41)), now)).toBeNull();
  });

  it('reports the tick as missed when the last run is older than it', () => {
    const prevMonday = iso(local(2026, 10, 26, 4, 50, 41));
    expect(missedTick(PLACEMENT, prevMonday, WED)).toEqual({ tick: local(2026, 11, 2, 4, 50), reason: 'missed' });
    // this Monday's own run, finished at 04:50:41, covers the 04:50 tick
    expect(missedTick(PLACEMENT, iso(local(2026, 11, 2, 4, 50, 41)), WED)).toBeNull();
    // one second short of the tick is still a miss
    expect(missedTick(PLACEMENT, iso(local(2026, 11, 2, 4, 49, 59)), WED)).toEqual({
      tick: local(2026, 11, 2, 4, 50),
      reason: 'missed',
    });
  });

  it('is null when last_run_at is exactly the tick, a miss one millisecond before it', () => {
    const tick = local(2026, 11, 2, 4, 50);
    expect(missedTick(PLACEMENT, iso(tick), WED)).toBeNull();
    expect(missedTick(PLACEMENT, iso(new Date(tick.getTime() - 1)), WED)?.reason).toBe('missed');
  });

  it('returns the tick before `now` when a boot lands on a tick, so it does not double with croner', () => {
    const last = STALE;
    const previous = local(2026, 10, 26, 4, 10);
    expect(missedTick('10 4 * * 1', last, local(2026, 11, 2, 4, 10))?.tick).toEqual(previous);
    // inside the tick's own second
    expect(missedTick('10 4 * * 1', last, local(2026, 11, 2, 4, 10, 0, 500))?.tick).toEqual(previous);
    // a second later the tick is a fact
    expect(missedTick('10 4 * * 1', last, local(2026, 11, 2, 4, 10, 1))?.tick).toEqual(local(2026, 11, 2, 4, 10));
  });

  it('takes a last_run_at up to 5 minutes ahead of now as real, and anything further as no record', () => {
    const now = WED;
    const ahead = (ms: number) => iso(new Date(now.getTime() + ms));
    expect(missedTick(PLACEMENT, ahead(2 * 60_000), now)).toBeNull();
    expect(missedTick(PLACEMENT, ahead(CATCH_UP_CLOCK_SKEW_MS), now)).toBeNull();
    expect(missedTick(PLACEMENT, ahead(CATCH_UP_CLOCK_SKEW_MS + 1), now)).toEqual({
      tick: local(2026, 11, 2, 4, 50),
      reason: 'no-record',
    });
  });

  it('reads an unparsable last_run_at as no record', () => {
    for (const garbage of ['not a date', '', '2026-13-45T99:99:99Z']) {
      expect(missedTick(PLACEMENT, garbage, WED)?.reason, JSON.stringify(garbage)).toBe('no-record');
    }
  });

  it('returns null, without throwing, for a cron it cannot use', () => {
    const now = WED;
    expect(missedTick('not a cron', null, now)).toBeNull();
    expect(msUntilNextTick('not a cron', now)).toBeNull();
    // an impossible date parses and then throws from previousRuns, which is a different path
    expect(missedTick('0 0 31 2 *', null, now)).toBeNull();
    expect(msUntilNextTick('0 0 31 2 *', now)).toBeNull();
    // a cron with no earlier tick (year 2099), and one with no later tick (year 2020)
    expect(missedTick('0 0 0 1 1 * 2099', null, now)).toBeNull();
    expect(msUntilNextTick('0 0 0 1 1 * 2020', now)).toBeNull();
  });

  it('does not call a tick missed that DST has put ahead of now', () => {
    const was = process.env.TZ;
    process.env.TZ = 'Europe/London';
    try {
      // The clocks went forward at 01:00 UTC, so 01:30 local never happened that day. croner
      // reads the tick as 02:30 BST, twenty minutes after this 02:10 BST.
      const now = new Date('2026-03-29T01:10:00Z');
      const lastNight = '2026-03-28T01:30:30.000Z';
      expect(missedTick('30 1 * * *', lastNight, now)).toBeNull();
      expect(missedTick('30 1 * * *', null, now)).toBeNull();
    } finally {
      process.env.TZ = was;
    }
  });

  it('finds the daily 01:30 tick on either side of 01:30', () => {
    const lastNight = iso(local(2026, 11, 3, 1, 30, 30));
    // 01:29:59 today: the tick in question is yesterday's, and last night's run covered it
    expect(missedTick('30 1 * * *', lastNight, local(2026, 11, 4, 1, 29, 59))).toBeNull();
    // 01:30:01 today: today's 01:30 has fallen, and last night's run is older than it
    expect(missedTick('30 1 * * *', lastNight, local(2026, 11, 4, 1, 30, 1))).toEqual({
      tick: local(2026, 11, 4, 1, 30),
      reason: 'missed',
    });
  });
});

describe('msUntilNextTick', () => {
  it('is the distance to the next tick, strictly after now', () => {
    expect(msUntilNextTick('10 4 * * 1', local(2026, 11, 2, 4, 1))).toBe(9 * 60_000);
    // exactly on the imminent-tick threshold
    expect(msUntilNextTick('10 4 * * 1', local(2026, 11, 2, 4, 0))).toBe(CATCH_UP_IMMINENT_MS);
    expect(msUntilNextTick('* * * * *', local(2026, 11, 4, 12, 0, 30))).toBe(30_000);
    // on the tick itself the next one is a week out
    const onTick = local(2026, 11, 2, 4, 10);
    expect(msUntilNextTick('10 4 * * 1', onTick)).toBe(local(2026, 11, 9, 4, 10).getTime() - onTick.getTime());
  });
});

describe('catchUpLogPrefix', () => {
  it('names the missed tick in local time, zero-padded', () => {
    expect(catchUpLogPrefix({ tick: local(2026, 11, 2, 4, 10), reason: 'missed' })).toBe(
      'Caught up (missed 2026-11-02 04:10) — ',
    );
    expect(catchUpLogPrefix({ tick: local(2026, 1, 5, 4, 5), reason: 'missed' })).toBe(
      'Caught up (missed 2026-01-05 04:05) — ',
    );
  });

  it('says there is no record rather than naming a tick', () => {
    expect(catchUpLogPrefix({ tick: local(2026, 11, 2, 4, 10), reason: 'no-record' })).toBe(
      'Caught up (no earlier run recorded) — ',
    );
  });
});

describe('constants', () => {
  it('are the ones the design settled on', () => {
    expect(CATCH_UP_DELAY_MS).toBe(60_000);
    expect(CATCH_UP_IMMINENT_MS).toBe(600_000);
    expect(CATCH_UP_CLOCK_SKEW_MS).toBe(300_000);
    expect(CATCH_UP_MAX_INTERRUPTED).toBe(2);
  });
});

// ── DB-backed ─────────────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  cron: string;
  enabled: number | null;
  last_run_at: string | null;
}
let savedJobs: JobRow[] = [];

function saveJobs(): void {
  savedJobs = sqlite.prepare('SELECT id, cron, enabled, last_run_at FROM scheduled_jobs').all() as JobRow[];
}

/** Put the seeded rows back as they were and drop any row a test added. */
function restoreJobs(): void {
  const keep = new Set(savedJobs.map((j) => j.id));
  for (const { id } of sqlite.prepare('SELECT id FROM scheduled_jobs').all() as { id: string }[]) {
    if (keep.has(id)) continue;
    sqlite.prepare('DELETE FROM job_runs WHERE job_id = ?').run(id);
    sqlite.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
  }
  const put = sqlite.prepare('UPDATE scheduled_jobs SET cron = ?, enabled = ?, last_run_at = ? WHERE id = ?');
  for (const j of savedJobs) put.run(j.cron, j.enabled, j.last_run_at, j.id);
}

const setLastRun = (kind: string, at: string | null): void => {
  sqlite.prepare('UPDATE scheduled_jobs SET last_run_at = ? WHERE kind = ?').run(at, kind);
};
const lastRunOf = (kind: string): string | null =>
  (sqlite.prepare('SELECT last_run_at FROM scheduled_jobs WHERE kind = ?').get(kind) as { last_run_at: string | null })
    .last_run_at;
/** Stamp the given kinds (default: the catch-up seven) with one last_run_at. */
const arm = (at: string | null, kinds: readonly string[] = KINDS): void => kinds.forEach((k) => setLastRun(k, at));
const jobId = (kind: string): string =>
  (sqlite.prepare('SELECT id FROM scheduled_jobs WHERE kind = ?').get(kind) as { id: string }).id;

interface RunRow {
  kind: string;
  status: string;
  log: string | null;
}
/** job_runs in the order they were written. started_at can tie within a millisecond. */
const runRows = (kind?: string): RunRow[] =>
  sqlite
    .prepare(
      `SELECT j.kind, r.status, r.log FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
        ${kind ? 'WHERE j.kind = ?' : ''} ORDER BY r.rowid`,
    )
    .all(...(kind ? [kind] : [])) as RunRow[];

const count = (table: string): number =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Yield to the event loop until `cond` holds. Not vi.waitFor: with Date faked it would
 *  advance the fake clock under the test. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise<void>((r) => setImmediate(r));
  if (!cond()) throw new Error('condition never held');
}

const setClock = (d: Date): void => {
  vi.setSystemTime(d);
};
const quiet = (m: 'warn' | 'info' | 'error') => vi.spyOn(logger, m).mockImplementation(() => undefined as never);
const catchUpLogs = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([msg]) => String(msg).startsWith('Catch-up'));

describe('runCatchUp', () => {
  let warn: ReturnType<typeof quiet>;
  let info: ReturnType<typeof quiet>;

  beforeEach(() => {
    resetDb();
    saveJobs();
    vi.useFakeTimers({ toFake: ['Date'] });
    setClock(WED);
    warn = quiet('warn');
    info = quiet('info');
    quiet('error'); // runJobInner logs every failed job at error
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreJobs();
  });
  afterAll(() => resetDb());

  it('makes up all seven overdue kinds, one at a time, in cron order, marked as caught up', async () => {
    arm(STALE);

    const started = await runCatchUp();

    expect(started).toEqual([...SEVEN]);
    // One row per kind and in cron order by rowid: a pass that ran them side by side would
    // interleave their row-opening, and a reshuffled tuple would show here.
    const rows = runRows();
    expect(rows.map((r) => r.kind)).toEqual([...SEVEN]);
    for (const row of rows) {
      expect(row.status, row.kind).toBe('done');
      expect(row.log, row.kind).toMatch(new RegExp(`^Caught up \\(missed ${WED_TICK[row.kind as CatchUpKind]}\\) — `));
    }
    for (const kind of CATCH_UP_KINDS) expect(lastRunOf(kind), kind).toBe(iso(WED));

    // observability: one info line per kind with the tick it looked back to, then a summary
    expect(info).toHaveBeenCalledWith('Catch-up: running a missed job', {
      kind: 'calibrate_triality',
      tick: iso(local(2026, 11, 2, 3, 50)),
      lastRunAt: STALE,
    });
    expect(info).toHaveBeenCalledWith('Catch-up finished', { started: [...SEVEN] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('looks at each kind when its turn comes, so a run that landed meanwhile satisfies it', async () => {
    const estimates = await import('../src/jobs/calibrate-estimates.js');
    vi.spyOn(estimates, 'calibrateEstimates').mockImplementation(async () => {
      // a real tick, or a manual run, finishing while the first kind is still going
      setLastRun('calibrate_dismissals', iso(WED));
      return { sample_count: 0, bias_ratio: null, p25: null, p50: null, p75: null };
    });
    arm(STALE);

    expect(await runCatchUp()).toEqual(SEVEN.filter((k) => k !== 'calibrate_dismissals'));
    expect(runRows('calibrate_dismissals')).toEqual([]);
  });

  it('does nothing, and says nothing, when no kind is overdue', async () => {
    arm(iso(WED));
    expect(await runCatchUp()).toEqual([]);
    expect(runRows()).toEqual([]);
    expect(catchUpLogs(info)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts a last_run_at that is exactly each kind\'s own latest tick as current', async () => {
    for (const { kind, cron } of sqlite
      .prepare(`SELECT kind, cron FROM scheduled_jobs WHERE kind IN (${KINDS.map(() => '?').join(',')})`)
      .all(...KINDS) as { kind: string; cron: string }[]) {
      setLastRun(kind, iso(new Cron(cron).previousRuns(1, WED)[0]));
    }
    expect(await runCatchUp()).toEqual([]);
    expect(runRows()).toEqual([]);
  });

  it('is idempotent: a second pass straight after starts nothing and writes nothing', async () => {
    arm(STALE);
    await runCatchUp();
    const tables = [
      'job_runs', 'audit_log', 'estimate_calibration', 'calibration_history', 'triality_weights',
      'classification_exemplars', 'classification_accuracy', 'possible_dismissal_exemplars',
      'possible_dismissal_rate', 'plan_loop_stats', 'balance_week_log', 'placement_preferences',
      'placement_survival',
    ];
    const before = tables.map(count);
    expect(before[0]).toBe(CATCH_UP_KINDS.length); // job_runs: the first pass did run

    expect(await runCatchUp()).toEqual([]);

    expect(tables.map(count)).toEqual(before);
  });

  describe('the kinds that are not caught up', () => {
    const excluded = (): string[] =>
      (sqlite.prepare('SELECT DISTINCT kind FROM scheduled_jobs').all() as { kind: string }[])
        .map((r) => r.kind)
        .filter((k) => !KINDS.includes(k));

    /** Rows whose jobs would each do visible harm if run at 09:00 (see NOT_CAUGHT_UP). */
    function plantHarm() {
      // resetDb keeps the system owner's patterns and pattern types, so reuse a Routine type if
      // one is there and remove only what this call added
      const existing = sqlite
        .prepare(`SELECT id FROM pattern_types WHERE owner_id = ? AND name = 'Routine' LIMIT 1`)
        .get(SYSTEM_OWNER) as { id: string } | undefined;
      const type =
        existing ??
        (sqlite
          .prepare(`INSERT INTO pattern_types (id, owner_id, name, icon_shape, is_builtin) VALUES (uuid7(), ?, 'Routine', 'circle', 1) RETURNING id`)
          .get(SYSTEM_OWNER) as { id: string });
      const pattern = sqlite
        .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, 'Morning') RETURNING id`)
        .get(SYSTEM_OWNER, type.id) as { id: string };
      // reset_routines would reopen what was ticked off this morning
      const routine = sqlite
        .prepare(`INSERT INTO tasks (id, title, owner_id, status, completed_at) VALUES (uuid7(), 'Make the bed', ?, 'done', ?) RETURNING id`)
        .get(SYSTEM_OWNER, iso(local(2026, 11, 4, 7, 30))) as { id: string };
      sqlite.prepare('INSERT INTO pattern_tasks (pattern_id, task_id) VALUES (?, ?)').run(pattern.id, routine.id);
      // review_day would defer this and delete its block; auto_schedule would mark the block skipped
      const planned = sqlite
        .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES (uuid7(), 'Write spec', ?, 'open', 3) RETURNING id`)
        .get(SYSTEM_OWNER) as { id: string };
      const block = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_auto, status, owner_id)
           VALUES (uuid7(), ?, 'b', 'task', ?, ?, 1, 'planned', ?) RETURNING id`,
        )
        .get(planned.id, iso(local(2026, 11, 4, 6, 0)), iso(local(2026, 11, 4, 7, 0)), SYSTEM_OWNER) as { id: string };
      // nightly_grooming would move this one up a priority step at every run
      const overdue = sqlite
        .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority, due_at) VALUES (uuid7(), 'File taxes', ?, 'open', 3, ?) RETURNING id`)
        .get(SYSTEM_OWNER, iso(local(2026, 11, 3, 17, 0))) as { id: string };
      return {
        state: () => ({
          routine: (sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(routine.id) as { status: string }).status,
          block: (sqlite.prepare('SELECT status FROM time_blocks WHERE id = ?').get(block.id) as { status: string } | undefined)?.status,
          priority: (sqlite.prepare('SELECT priority FROM tasks WHERE id = ?').get(overdue.id) as { priority: number }).priority,
        }),
        clear: () => {
          sqlite.prepare('DELETE FROM pattern_tasks WHERE pattern_id = ?').run(pattern.id);
          sqlite.prepare('DELETE FROM patterns WHERE id = ?').run(pattern.id);
          if (!existing) sqlite.prepare('DELETE FROM pattern_types WHERE id = ?').run(type.id);
        },
      };
    }

    it('never runs, whatever its last_run_at says', async () => {
      // the seven are current, so only the excluded kinds could be started, and every one of
      // them is stale: null on some, years old on the rest
      arm(iso(WED));
      excluded().forEach((kind, i) => setLastRun(kind, i % 2 ? null : '2020-01-01T00:00:00.000Z'));
      const harm = plantHarm();
      try {
        expect(await runCatchUp()).toEqual([]);

        expect(runRows()).toEqual([]);
        expect(harm.state()).toEqual({ routine: 'done', block: 'planned', priority: 3 });
      } finally {
        harm.clear();
      }
    });

    it('would have done that harm: the planted rows are ones the excluded jobs really change', async () => {
      // The check above means nothing if the plants are insensitive. These are the functions
      // reset_routines, review_day and nightly_grooming run.
      const harm = plantHarm();
      try {
        await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, async () => {
          await resetRoutineTasks();
          await surfaceOverdue();
        });
        await reviewAndReschedule();

        expect(harm.state()).toEqual({ routine: 'open', block: undefined, priority: 2 });
      } finally {
        harm.clear();
      }
    });
  });

  it('skips a kind whose job row is disabled', async () => {
    arm(STALE);
    sqlite.prepare(`UPDATE scheduled_jobs SET enabled = 0 WHERE kind = 'calibrate_dismissals'`).run();

    const started = await runCatchUp();

    expect(started).toEqual(KINDS.filter((k) => k !== 'calibrate_dismissals'));
    expect(runRows('calibrate_dismissals')).toEqual([]);
    expect(lastRunOf('calibrate_dismissals')).toBe(STALE);
  });

  it('reads the first enabled row by name when two rows share a kind', async () => {
    arm(iso(WED));
    // 'a-…' sorts before 'calibrate_triality'. It is stale, the seeded row is current: the
    // first by name decides, so triality is run, and a row that sorts after it would not.
    sqlite
      .prepare(`INSERT INTO scheduled_jobs (id, name, kind, cron, enabled, last_run_at) VALUES (uuid7(), ?, 'calibrate_triality', '50 3 * * 1', 1, ?)`)
      .run('a-triality-copy', STALE);
    expect(await runCatchUp()).toEqual(['calibrate_triality']);

    arm(iso(WED));
    sqlite.prepare(`UPDATE scheduled_jobs SET name = 'z-triality-copy' WHERE name = 'a-triality-copy'`).run();
    sqlite.prepare(`UPDATE scheduled_jobs SET last_run_at = ? WHERE name = 'z-triality-copy'`).run(STALE);
    expect(await runCatchUp()).toEqual([]);
  });

  it('runs an owner-scoped kind once per owner, for all seven', async () => {
    createOwner();
    arm(STALE);

    expect(await runCatchUp()).toEqual([...CATCH_UP_KINDS]);

    // two rows each also proves every one of the seven is owner-scoped: OWNER_SCOPED_KINDS
    // is not exported, and a kind missing from it would have run once
    for (const kind of CATCH_UP_KINDS) {
      expect(runRows(kind).map((r) => r.status), kind).toEqual(['done', 'done']);
    }
  });

  describe('a run that errors', () => {
    it('counts as attempted: it is logged as caught up, stamped, not retried, and the rest still run', async () => {
      const triality = await import('../src/services/triality-learning.js');
      vi.spyOn(triality, 'calibrateTriality').mockRejectedValue(new Error('weights table is gone'));
      arm(STALE);

      const started = await runCatchUp();

      expect(started).toEqual([...CATCH_UP_KINDS]);
      const rows = runRows('calibrate_triality');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('error');
      expect(rows[0].log).toMatch(/^Caught up \(missed 2026-11-02 03:50\) — /);
      expect(rows[0].log).toContain('weights table is gone');
      expect(lastRunOf('calibrate_triality')).toBe(iso(WED));
      for (const kind of KINDS.filter((k) => k !== 'calibrate_triality')) {
        expect(runRows(kind).map((r) => r.status), kind).toEqual(['done']);
      }

      // a failed run is a spent attempt, like a failed tick: the next boot does not redo it
      expect(await runCatchUp()).toEqual([]);
      expect(runRows('calibrate_triality')).toHaveLength(1);
    });
  });

  describe('the interrupted-attempt cap', () => {
    const KIND = 'calibrate_classification'; // its tick, as WED sees it, is Mon 04:10
    const TICK = local(2026, 11, 2, 4, 10);
    const AFTER_TICK = local(2026, 11, 3, 12, 0);

    function plant(n: number, o: { kind?: string; startedAt?: Date; status?: string; log?: string } = {}): void {
      for (let i = 0; i < n; i++) {
        sqlite
          .prepare(`INSERT INTO job_runs (id, job_id, started_at, finished_at, status, log) VALUES (uuid7(), ?, ?, ?, ?, ?)`)
          .run(jobId(o.kind ?? KIND), iso(o.startedAt ?? AFTER_TICK), iso(o.startedAt ?? AFTER_TICK), o.status ?? 'error', o.log ?? INTERRUPTED_RUN_LOG);
      }
    }
    const others = KINDS.filter((k) => k !== KIND);

    it('still runs a kind that has been interrupted once since the tick', async () => {
      arm(STALE);
      plant(1);
      expect(await runCatchUp()).toEqual([...CATCH_UP_KINDS]);
      expect(runRows(KIND).map((r) => r.status)).toEqual(['error', 'done']);
    });

    it('skips it, with a warning, once it has been interrupted twice', async () => {
      arm(STALE);
      plant(CATCH_UP_MAX_INTERRUPTED);

      const started = await runCatchUp();

      expect(started).toEqual(others);
      expect(warn).toHaveBeenCalledWith(
        'Catch-up: skipped, interrupted 2 times since the missed tick',
        { kind: KIND },
      );
      expect(runRows(KIND)).toHaveLength(2); // the two planted, nothing new
      expect(lastRunOf(KIND)).toBe(STALE);
    });

    it('counts a row that started exactly at the tick', async () => {
      arm(STALE);
      plant(2, { startedAt: TICK });
      expect(await runCatchUp()).toEqual(others);
    });

    // Each case plants a full cap's worth, so a count that wrongly included it would skip the kind.
    it.each([
      ['a row from before the tick', { startedAt: new Date(TICK.getTime() - 1) }],
      ['an error with another log', { log: 'weights table is gone' }],
      ['an interrupted-looking row that did not end in error', { status: 'done' }],
    ])('does not count %s', async (_what, row) => {
      arm(STALE);
      plant(CATCH_UP_MAX_INTERRUPTED, row);
      expect(await runCatchUp()).toEqual([...SEVEN]);
    });

    it('counts per kind: another kind\'s interrupted rows do not hold this one back', async () => {
      arm(STALE);
      plant(CATCH_UP_MAX_INTERRUPTED, { kind: 'calibrate_placement' });

      const started = await runCatchUp();

      expect(started).toContain(KIND);
      expect(started).not.toContain('calibrate_placement'); // its own two do count, for it
    });
  });

  describe('a kind with no usable record', () => {
    it('runs once with the "no earlier run recorded" prefix when last_run_at is null', async () => {
      arm(iso(WED));
      setLastRun('calibrate_triality', null);

      expect(await runCatchUp()).toEqual(['calibrate_triality']);

      const rows = runRows('calibrate_triality');
      expect(rows).toHaveLength(1);
      expect(rows[0].log).toMatch(/^Caught up \(no earlier run recorded\) — /);
      expect(lastRunOf('calibrate_triality')).toBe(iso(WED));
      expect(await runCatchUp()).toEqual([]); // the stamp it wrote ends it
    });

    it('treats a future-dated last_run_at the same way, and repairs it', async () => {
      arm(iso(WED));
      setLastRun('calibrate_triality', iso(local(2026, 11, 5, 9, 0)));

      expect(await runCatchUp()).toEqual(['calibrate_triality']);

      expect(runRows('calibrate_triality')[0].log).toMatch(/^Caught up \(no earlier run recorded\) — /);
      expect(lastRunOf('calibrate_triality')).toBe(iso(WED));
    });

    it('leaves a last_run_at a couple of minutes ahead alone: a clock a little fast is a real stamp', async () => {
      arm(iso(WED));
      const ahead = iso(new Date(WED.getTime() + 2 * 60_000));
      setLastRun('calibrate_triality', ahead);

      expect(await runCatchUp()).toEqual([]);
      expect(lastRunOf('calibrate_triality')).toBe(ahead);
    });

    it('makes up all seven once on a fresh install, where every stamp is null', async () => {
      arm(null);
      expect(await runCatchUp()).toEqual([...CATCH_UP_KINDS]);
      for (const row of runRows()) expect(row.log).toMatch(/^Caught up \(no earlier run recorded\) — /);
    });
  });

  describe('a tick that is close', () => {
    it('leaves a kind to its real tick when that is under 10 minutes away, and runs the ones already past', async () => {
      // Mon 04:06: triality (03:50) is past, classification's 04:10 is 4 minutes out
      setClock(local(2026, 11, 2, 4, 6));
      arm(STALE);

      const started = await runCatchUp();

      expect(started).toEqual(KINDS.filter((k) => k !== 'calibrate_classification'));
      expect(runRows('calibrate_classification')).toEqual([]);
      expect(lastRunOf('calibrate_classification')).toBe(STALE);
      expect(runRows('calibrate_triality')[0].log).toMatch(/^Caught up \(missed 2026-11-02 03:50\) — /);
      expect(warn).not.toHaveBeenCalled();
    });

    it('draws the line at exactly 10 minutes: at 10 minutes it waits, a second further out it runs', async () => {
      setClock(local(2026, 11, 2, 4, 0, 0));
      arm(STALE);
      expect(await runCatchUp()).not.toContain('calibrate_classification');

      resetDb();
      setClock(local(2026, 11, 2, 3, 59, 59));
      arm(STALE);
      expect(await runCatchUp()).toContain('calibrate_classification');
    });

    it('runs it once the tick has gone by', async () => {
      setClock(local(2026, 11, 2, 4, 30));
      arm(STALE);

      const started = await runCatchUp();

      expect(started).toContain('calibrate_classification');
      expect(runRows('calibrate_classification')[0].log).toMatch(/^Caught up \(missed 2026-11-02 04:10\) — /);
    });
  });

  describe('against a real tick of the same kind', () => {
    it('leaves it alone quietly: no second run, no "previous run is still going" warning', async () => {
      const triality = await import('../src/services/triality-learning.js');
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const slow = vi.spyOn(triality, 'calibrateTriality').mockImplementation(async () => {
        await gate;
        return { outcomeRows: 0, slotsWritten: 0, slotsFloored: 0, floor: 0 };
      });
      arm(STALE);

      // the croner callback, holding the tick lock
      const tick = runScheduledJob('calibrate_triality');
      await until(() => slow.mock.calls.length > 0);

      let started: string[];
      try {
        started = await runCatchUp();
      } finally {
        release(); // a failed assertion must not leave the tick lock held for the tests after it
        await tick;
      }

      expect(started).toEqual(KINDS.filter((k) => k !== 'calibrate_triality'));
      expect(warn.mock.calls.filter(([m]) => String(m).includes('previous run is still going'))).toEqual([]);
      const rows = runRows('calibrate_triality');
      expect(rows).toHaveLength(1); // the tick's own
      expect(rows[0].log).not.toMatch(/^Caught up/);
      for (const kind of KINDS.filter((k) => k !== 'calibrate_triality')) {
        expect(runRows(kind).map((r) => r.status), kind).toEqual(['done']);
      }
    });
  });

  /**
   * What last_run_at cannot say. It is one value per KIND, so these are accepted limits, each
   * pinned here so a change to them is a decision and not an accident. They fall back to the
   * behaviour before catch-up existed (no run until the next tick), or to a bounded retry.
   */
  describe('known blind spots (characterised, not endorsed)', () => {
    const KIND = 'calibrate_placement';
    const rest = KINDS.filter((k) => k !== KIND);

    it('a manual run by ONE owner after the tick makes the kind current for every owner', async () => {
      createOwner();
      arm(STALE);
      // someone pressing "Run all" on their own account: the stamp is the kind's, not theirs
      await runWithOwner(SECOND_OWNER_ID, ALL_SCOPES, () => runJob(KIND));

      expect(await runCatchUp()).toEqual(rest);
      expect(runRows(KIND)).toHaveLength(1); // the system owner never got a run
    });

    it('a fan-out that reached only owner A leaves owner B without a run, and is not retried', async () => {
      createOwner();
      arm(STALE);
      // job_runs has no owner column, so one row and a fresh stamp look like a finished fan-out
      await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => runJob(KIND));

      expect(await runCatchUp()).toEqual(rest);
      expect(runRows(KIND)).toHaveLength(1);
    });

    it('an earlier errored attempt counts: the stamp is written for error runs too', async () => {
      const placement = await import('../src/services/placement-learning.js');
      vi.spyOn(placement, 'calibratePlacement').mockRejectedValue(new Error('boom'));
      arm(STALE);
      expect((await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => runJob(KIND))).status).toBe('error');

      expect(await runCatchUp()).toEqual(rest);
    });

    it('a run left `running` and settled by failInterruptedJobRuns counts toward the cap', async () => {
      arm(STALE);
      const open = sqlite.prepare(`INSERT INTO job_runs (id, job_id, started_at, status) VALUES (uuid7(), ?, ?, 'running')`);
      open.run(jobId(KIND), iso(local(2026, 11, 3, 12, 0)));
      await failInterruptedJobRuns();
      expect(await runCatchUp()).toEqual([...CATCH_UP_KINDS]); // one interrupted attempt: still tried

      resetDb();
      arm(STALE);
      open.run(jobId(KIND), iso(local(2026, 11, 3, 12, 0)));
      open.run(jobId(KIND), iso(local(2026, 11, 3, 13, 0)));
      await failInterruptedJobRuns();
      expect(await runCatchUp()).toEqual(rest); // the writer's log is the one the counter reads
    });
  });

  describe('never rejects', () => {
    it('skips a job row whose cron cannot be used and carries on', async () => {
      arm(STALE);
      sqlite.prepare(`UPDATE scheduled_jobs SET cron = 'every now and then' WHERE kind = 'calibrate_triality'`).run();
      sqlite.prepare(`UPDATE scheduled_jobs SET cron = '0 0 31 2 *' WHERE kind = 'calibrate_classification'`).run();

      const started = await runCatchUp();

      expect(started).toEqual(KINDS.filter((k) => k !== 'calibrate_triality' && k !== 'calibrate_classification'));
      expect(warn).not.toHaveBeenCalled(); // a row with no usable schedule is not an incident
    });

    // only the first statement fails, the first kind's row read, the way a lost connection would
    const reject = () => Promise.reject(new Error('db gone'));
    it.each([
      ['a statement that rejects', () => ({ get: reject, all: reject, run: reject })],
      ['a prepare that throws', () => { throw new Error('db gone'); }],
    ])('resolves when the database fails under it (%s), warns, and still tries the later kinds', async (_how, fail) => {
      arm(STALE);
      vi.spyOn(store(), 'prepare').mockImplementationOnce(fail as never);

      const started = await runCatchUp();

      expect(started).toEqual(KINDS.filter((k) => k !== 'calibrate_estimates'));
      expect(warn).toHaveBeenCalledWith('Catch-up failed', { kind: 'calibrate_estimates', err: 'db gone' });
    });
  });

  describe('abort (shutdown)', () => {
    it('starts nothing when the signal is already aborted', async () => {
      arm(STALE);
      const c = new AbortController();
      c.abort();

      expect(await runCatchUp({ signal: c.signal })).toEqual([]);
      expect(runRows()).toEqual([]);
    });

    it('stops before the next kind when it is aborted during the first', async () => {
      const estimates = await import('../src/jobs/calibrate-estimates.js');
      const c = new AbortController();
      vi.spyOn(estimates, 'calibrateEstimates').mockImplementation(async () => {
        c.abort(); // SIGTERM lands while the first kind is running
        return { sample_count: 0, bias_ratio: null, p25: null, p50: null, p75: null };
      });
      arm(STALE);

      const started = await runCatchUp({ signal: c.signal });

      expect(started).toEqual(['calibrate_estimates']);
      expect(runRows().map((r) => r.kind)).toEqual(['calibrate_estimates']); // the one in flight finished
      expect(lastRunOf('calibrate_triality')).toBe(STALE);
    });
  });
});

// ── guards over the registry ──────────────────────────────────────────────────────────

describe('every job kind has a catch-up decision', () => {
  const seeded = (): string[] =>
    (sqlite.prepare('SELECT DISTINCT kind FROM scheduled_jobs').all() as { kind: string }[]).map((r) => r.kind);

  it('has each seeded kind either in CATCH_UP_KINDS or given a reason in NOT_CAUGHT_UP', () => {
    // A migration that seeds a job fails here until someone decides which side it is on.
    const decided = new Set<string>([...CATCH_UP_KINDS, ...Object.keys(NOT_CAUGHT_UP)]);
    expect(seeded().filter((k) => !decided.has(k))).toEqual([]);
  });

  it('is exactly the seven learning-loop kinds, in cron order', () => {
    expect([...CATCH_UP_KINDS]).toEqual([...SEVEN]);
  });

  it('keeps the two sides apart, with a reason for every exclusion and no stale entries', () => {
    expect(CATCH_UP_KINDS.filter((k) => k in NOT_CAUGHT_UP)).toEqual([]);
    expect(new Set(CATCH_UP_KINDS).size).toBe(CATCH_UP_KINDS.length);
    for (const [kind, reason] of Object.entries(NOT_CAUGHT_UP)) {
      expect(reason.trim().length, kind).toBeGreaterThan(0);
    }
    // promote_possibles has no cron row since 0118 but stays executable, so it is listed anyway
    const known = new Set([...seeded(), 'promote_possibles']);
    expect(Object.keys(NOT_CAUGHT_UP).filter((k) => !known.has(k))).toEqual([]);
    expect(CATCH_UP_KINDS.filter((k) => !known.has(k))).toEqual([]);
  });

  it('lists the kinds in the order their crons first fire in a week', () => {
    // The stagger the migrations chose keeps the model kinds off one GPU at once; catch-up
    // inherits it only if the tuple stays in cron order: estimates, then the Monday block.
    const crons = sqlite
      .prepare(`SELECT kind, cron FROM scheduled_jobs WHERE kind IN (${KINDS.map(() => '?').join(',')})`)
      .all(...KINDS) as { kind: string; cron: string }[];
    const mondayMidnight = local(2026, 11, 2, 0, 0);
    const firstFire = (cron: string) => new Cron(cron).nextRun(mondayMidnight)!.getTime();
    const byFiring = [...crons].sort((a, b) => firstFire(a.cron) - firstFire(b.cron)).map((r) => r.kind);
    expect(byFiring).toEqual([...CATCH_UP_KINDS]);
  });
});

// ── the boot timer ────────────────────────────────────────────────────────────────────

describe('scheduleCatchUp', () => {
  afterEach(() => {
    cancelCatchUp();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs once at the delay, on an unref\'d timer, with a live signal', () => {
    vi.useFakeTimers();
    const run = vi.fn(async (_signal: AbortSignal) => undefined);

    const timer = scheduleCatchUp(run, 60_000);

    expect(timer.hasRef()).toBe(false); // must never keep the process alive
    vi.advanceTimersByTime(59_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].aborted).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1); // once, no sweep
  });

  it('waits CATCH_UP_DELAY_MS when no delay is given', () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    scheduleCatchUp(run);
    vi.advanceTimersByTime(CATCH_UP_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps a rejection from the pass away from unhandledRejection, which would take the server down', async () => {
    vi.useFakeTimers();
    const warn = quiet('warn');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      scheduleCatchUp(async () => { throw new Error('the pass blew up'); }, 1_000);
      vi.advanceTimersByTime(1_000);
      vi.useRealTimers();
      // an unhandled rejection is reported on a later turn of the loop, so give it one
      await new Promise<void>((r) => setTimeout(r, 25));

      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Catch-up failed', { err: 'the pass blew up' });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('never runs when cancelled before the delay', () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    scheduleCatchUp(run, 60_000);

    cancelCatchUp();
    vi.advanceTimersByTime(10 * 60_000);

    expect(run).not.toHaveBeenCalled();
  });

  it('aborts the signal of a pass that is already under way when cancelled', () => {
    vi.useFakeTimers();
    const run = vi.fn(async (_signal: AbortSignal) => undefined);
    scheduleCatchUp(run, 60_000);
    vi.advanceTimersByTime(60_000);
    const signal = run.mock.calls[0][0];
    expect(signal.aborted).toBe(false);

    cancelCatchUp();

    expect(signal.aborted).toBe(true);
    expect(() => cancelCatchUp()).not.toThrow(); // and a second call, with nothing armed, is harmless
  });

  it('replaces an armed pass rather than leaving two', () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    scheduleCatchUp(first, 60_000);
    scheduleCatchUp(second, 60_000);

    vi.advanceTimersByTime(60_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  describe('with the real pass behind it', () => {
    beforeEach(() => {
      resetDb();
      saveJobs();
    });
    afterEach(() => {
      restoreJobs();
      resetDb();
    });

    it('hands runCatchUp the signal, so a shutdown during the pass stops it before the next kind', async () => {
      // setTimeout and Date only: setImmediate and promises stay real for the pass itself
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(WED);
      const info = quiet('info');
      quiet('warn');
      quiet('error');
      const estimates = await import('../src/jobs/calibrate-estimates.js');
      vi.spyOn(estimates, 'calibrateEstimates').mockImplementation(async () => {
        cancelCatchUp(); // the SIGTERM handler's first call
        return { sample_count: 0, bias_ratio: null, p25: null, p50: null, p75: null };
      });
      arm(STALE);

      scheduleCatchUp();
      await vi.advanceTimersByTimeAsync(CATCH_UP_DELAY_MS - 1);
      expect(runRows()).toEqual([]); // the delay is the real one
      await vi.advanceTimersByTimeAsync(1);
      await until(() => info.mock.calls.some(([m]) => m === 'Catch-up finished'));

      expect(info).toHaveBeenCalledWith('Catch-up finished', { started: ['calibrate_estimates'] });
      expect(runRows().map((r) => r.kind)).toEqual(['calibrate_estimates']);
    });
  });
});
