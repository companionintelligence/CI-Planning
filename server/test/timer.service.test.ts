import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, runWithOwner, SYSTEM_OWNER } from '../src/lib/context.js';
import { startTimer, stopTimer, stopRunning, getRunning } from '../src/services/timer.js';
import { elapsedMinutes } from '../src/lib/duration.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;

/** Insert a bare task and return its id. */
function insertTask(title = 'Timed task'): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, priority, owner_id, status) VALUES (uuid7(), ?, 3, ?, 'open') RETURNING id`
      )
      .get(title, OWNER) as { id: string }
  ).id;
}

/** Insert a finished entry directly with explicit instants (UTC ISO). */
function insertEntry(taskId: string, startedAt: string, endedAt: string | null): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_entries (id, task_id, owner_id, started_at, ended_at, source)
         VALUES (uuid7(), ?, ?, ?, ?, 'timer') RETURNING id`
      )
      .get(taskId, OWNER, startedAt, endedAt) as { id: string }
  ).id;
}

const actualOf = (taskId: string) =>
  (sqlite.prepare(`SELECT actual_minutes AS m FROM tasks WHERE id = ?`).get(taskId) as { m: number }).m;

const runningRows = () =>
  sqlite
    .prepare(`SELECT id FROM time_entries WHERE owner_id = ? AND ended_at IS NULL`)
    .all(OWNER) as { id: string }[];

const recompute = (taskId: string): number => {
  const { total } = sqlite
    .prepare(
      `SELECT COALESCE(SUM((julianday(ended_at) - julianday(started_at)) * 24 * 60), 0) AS total
         FROM time_entries WHERE task_id = ? AND ended_at IS NOT NULL`
    )
    .get(taskId) as { total: number };
  const actual = Math.round(total);
  sqlite.prepare(`UPDATE tasks SET actual_minutes = ? WHERE id = ?`).run(actual, taskId);
  return actual;
};

describe('duration.elapsedMinutes', () => {
  it('measures real elapsed minutes from two UTC instants', () => {
    expect(elapsedMinutes('2026-06-15T10:00:00.000Z', '2026-06-15T10:30:00.000Z')).toBe(30);
  });

  it('is DST-correct: 01:30→02:30 across US spring-forward is 60 real minutes', () => {
    // 2026 US DST spring-forward: 2026-03-08 02:00 local (PST→PDT). The local
    // clock "loses" an hour, but the absolute instants are exactly 60 min apart.
    // 01:30 PST = 09:30Z; 02:30 PDT = 09:30Z + 60min = 10:30Z (02:00 PST = 10:00Z).
    const startISO = '2026-03-08T09:30:00.000Z'; // 01:30 America/Los_Angeles (PST, UTC-8)
    const endISO = '2026-03-08T10:30:00.000Z'; // 02:30 America/Los_Angeles (PDT, UTC-7)
    expect(elapsedMinutes(startISO, endISO)).toBe(60);
  });

  it('clamps a reversed pair to 0', () => {
    expect(elapsedMinutes('2026-06-15T11:00:00.000Z', '2026-06-15T10:00:00.000Z')).toBe(0);
  });
});

describe('timer service', () => {
  beforeEach(() => resetDb());

  it('start creates exactly one running entry', () => {
    const task = insertTask();
    runWithOwner(OWNER, ALL_SCOPES, () => {
      const { entry, stopped } = startTimer(task);
      expect(stopped).toBeNull();
      expect(entry.task_id).toBe(task);
      expect(entry.ended_at).toBeNull();
      expect(entry.source).toBe('timer');
    });
    expect(runningRows()).toHaveLength(1);
  });

  it('starting a 2nd timer stops the 1st (partial unique index never violated)', () => {
    const a = insertTask('A');
    const b = insertTask('B');
    runWithOwner(OWNER, ALL_SCOPES, () => {
      const first = startTimer(a);
      const second = startTimer(b);

      // The second start reports the superseded (first) entry as stopped.
      expect(second.stopped).not.toBeNull();
      expect(second.stopped!.entry.id).toBe(first.entry.id);
      expect(second.stopped!.entry.ended_at).not.toBeNull();
      expect(second.entry.task_id).toBe(b);
      expect(second.entry.ended_at).toBeNull();
    });

    // Invariant: at most one running entry at any time.
    const running = runningRows();
    expect(running).toHaveLength(1);

    // The first entry is now closed in the DB.
    const firstClosed = sqlite
      .prepare(`SELECT ended_at FROM time_entries WHERE task_id = ?`)
      .get(a) as { ended_at: string | null };
    expect(firstClosed.ended_at).not.toBeNull();
  });

  it('block-sourced start records source=block and the block link', () => {
    const task = insertTask();
    const blockId = (
      sqlite
        .prepare(
          `INSERT INTO time_blocks (id, task_id, title, start_at, end_at, status, owner_id)
           VALUES (uuid7(), ?, 'block', '2026-06-15T10:00:00Z', '2026-06-15T11:00:00Z', 'planned', ?) RETURNING id`
        )
        .get(task, OWNER) as { id: string }
    ).id;
    runWithOwner(OWNER, ALL_SCOPES, () => {
      const { entry } = startTimer(task, blockId);
      expect(entry.source).toBe('block');
      expect(entry.block_id).toBe(blockId);
    });
  });

  it('stop closes the running entry and recomputes actual_minutes', () => {
    const task = insertTask();
    // Seed two prior finished entries totaling 90 minutes, then run + stop a live one.
    insertEntry(task, '2026-06-15T08:00:00.000Z', '2026-06-15T08:30:00.000Z'); // 30
    insertEntry(task, '2026-06-15T09:00:00.000Z', '2026-06-15T10:00:00.000Z'); // 60
    recompute(task); // baseline 90

    runWithOwner(OWNER, ALL_SCOPES, () => {
      const { entry } = startTimer(task);
      // Backdate the live entry's start so the stop produces a deterministic duration.
      const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
      sqlite.prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`).run(tenMinAgo, entry.id);

      const res = stopTimer();
      expect(res).not.toBeNull();
      expect(res!.entry.ended_at).not.toBeNull();
      expect(res!.taskId).toBe(task);
      // 90 prior + ~10 live = ~100, recomputed from SUM of finished entries.
      expect(res!.actualMinutes).toBe(100);
    });
    expect(actualOf(task)).toBe(100);
    expect(runningRows()).toHaveLength(0);
  });

  it('actual_minutes aggregates across multiple entries and is recomputed, not incremented', () => {
    const task = insertTask();
    // Three finished sessions: 30 + 45 + 15 = 90.
    insertEntry(task, '2026-06-15T08:00:00.000Z', '2026-06-15T08:30:00.000Z'); // 30
    insertEntry(task, '2026-06-15T09:00:00.000Z', '2026-06-15T09:45:00.000Z'); // 45
    const third = insertEntry(task, '2026-06-15T10:00:00.000Z', '2026-06-15T10:15:00.000Z'); // 15
    expect(recompute(task)).toBe(90);

    // Deleting an entry must CORRECT the total downward (recompute, not +=).
    sqlite.prepare(`DELETE FROM time_entries WHERE id = ?`).run(third);
    expect(recompute(task)).toBe(75);

    // A stop also recomputes from the source of truth.
    runWithOwner(OWNER, ALL_SCOPES, () => {
      const { entry } = startTimer(task);
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      sqlite.prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`).run(fiveMinAgo, entry.id);
      const res = stopTimer();
      expect(res!.actualMinutes).toBe(80); // 75 + ~5
    });
    expect(actualOf(task)).toBe(80);
  });

  it('actuals are DST-correct: a timer spanning spring-forward measures 60 minutes', () => {
    const task = insertTask();
    // 01:30 PST → 02:30 PDT (US spring-forward 2026-03-08). Stored as UTC instants
    // that are 60 real minutes apart; the SUM uses julianday on those instants.
    insertEntry(task, '2026-03-08T09:30:00.000Z', '2026-03-08T10:30:00.000Z');
    expect(recompute(task)).toBe(60);
  });

  it('stopTimer with no running timer returns null', () => {
    runWithOwner(OWNER, ALL_SCOPES, () => {
      expect(stopTimer()).toBeNull();
      expect(stopRunning(OWNER)).toBeNull();
    });
  });

  it('getRunning returns the live entry, then null after stop', () => {
    const task = insertTask();
    runWithOwner(OWNER, ALL_SCOPES, () => {
      const { entry } = startTimer(task);
      const live = getRunning(OWNER);
      expect(live).not.toBeNull();
      expect(live!.id).toBe(entry.id);
      stopTimer();
      expect(getRunning(OWNER)).toBeNull();
    });
  });
});

describe('timer API + recovery', () => {
  let srv: TestServer;
  beforeEach(async () => {
    resetDb();
    srv = await startTestServer();
  });

  it('POST start → 201, GET /api/timer recovers it after a fresh start, stop → entry + actuals', async () => {
    const task = insertTask();

    const started = await api(srv.url, `/api/tasks/${task}/timer/start`, {
      method: 'POST',
      json: {},
    });
    expect(started.status).toBe(201);
    expect(started.body.entry.task_id).toBe(task);
    expect(started.body.entry.ended_at).toBeNull();

    // Recovery: a fresh GET surfaces the running entry (survives reload/restart).
    const current = await api(srv.url, `/api/timer`);
    expect(current.status).toBe(200);
    expect(current.body.entry).not.toBeNull();
    expect(current.body.entry.id).toBe(started.body.entry.id);

    // Backdate so the stop produces a non-zero, deterministic actual.
    const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    sqlite
      .prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`)
      .run(sixMinAgo, started.body.entry.id);

    const stopped = await api(srv.url, `/api/tasks/${task}/timer/stop`, {
      method: 'POST',
      json: {},
    });
    expect(stopped.status).toBe(200);
    expect(stopped.body.entry.ended_at).not.toBeNull();
    expect(stopped.body.actual_minutes).toBe(6);

    // After stop, nothing is running.
    const after = await api(srv.url, `/api/timer`);
    expect(after.body.entry).toBeNull();

    await srv.close();
  });

  it('POST stop with no running timer → 409', async () => {
    const task = insertTask();
    const res = await api(srv.url, `/api/tasks/${task}/timer/stop`, {
      method: 'POST',
      json: {},
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no running timer');
    await srv.close();
  });
});
