import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { syncToMemory } from '../src/services/memory.js';
import { runScheduledJob } from '../src/jobs/index.js';
import { resetDb } from './helpers.js';

/**
 * Phase AA · AA4 — one-way PUSH to CI-Server companion-memory. Fixture mode (default)
 * does NO network: postEvents reports every built event as ingested, so these tests
 * never hit the wire — they exercise the guard state machine, the scope-gated event
 * building (completed / habit / reflection), the watermark, and the daily push_memory
 * job (registration + per-owner fan-out + no-op logging).
 *
 * Availability is creds-driven (same as the pull side): CI_SERVER_URL is set so env
 * creds resolve; MEMORY_MODE stays unset (fixture) so nothing leaves the process.
 */

const OWNER = SYSTEM_OWNER;

const SAVED = {
  url: process.env.CI_SERVER_URL,
  apiKey: process.env.CI_SERVER_API_KEY,
  mode: process.env.MEMORY_MODE,
};

function setPrefs(fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  sqlite.prepare(`UPDATE scheduling_prefs SET ${set} WHERE owner_id = ?`).run(...keys.map((k) => fields[k]), OWNER);
}

/** Insert a completed top-level task; completed_at drives the watermark. */
function insertDoneTask(title: string, completedAt: string, extra: Record<string, unknown> = {}): string {
  const est = extra.estimated_minutes ?? null;
  const act = extra.actual_minutes ?? 0;
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, completed_at, estimated_minutes, actual_minutes)
         VALUES (uuid7(), ?, ?, 'done', ?, ?, ?) RETURNING id`,
      )
      .get(title, OWNER, completedAt, est, act) as { id: string }
  ).id;
}

const habitTypeId = () =>
  (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND is_builtin = 1 AND owner_id = ?`).get(OWNER) as { id: string }).id;

/** Make a Habit-type pattern and add the given task ids as members. */
function makeHabitPattern(name: string, taskIds: string[]): string {
  const pid = (
    sqlite.prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING id`).get(OWNER, habitTypeId(), name) as {
      id: string;
    }
  ).id;
  taskIds.forEach((tid, i) => sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(pid, tid, i));
  return pid;
}

function insertReflection(kind: string, periodKey: string, body: string, updatedAt: string) {
  sqlite
    .prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(OWNER, kind, periodKey, body, updatedAt, updatedAt);
}

const lastSyncedAt = () =>
  (sqlite.prepare(`SELECT memory_last_synced_at AS ts FROM scheduling_prefs WHERE owner_id = ?`).get(OWNER) as { ts: string | null }).ts;

beforeEach(() => {
  resetDb(); // clears tasks / reflections / patterns membership; keeps prefs row + builtin pattern_types
  delete process.env.MEMORY_MODE; // fixture (no network)
  process.env.CI_SERVER_URL = 'http://ci.local:3000'; // env creds → available
  delete process.env.CI_SERVER_API_KEY;
  // Push side isn't reset by resetDb — pin to the "enabled + connected, all scopes on" baseline.
  setPrefs({
    memory_sync_enabled: 1,
    memory_account: 'liam@x.io',
    memory_last_synced_at: null,
    memory_sync_completed: 1,
    memory_sync_habits: 1,
    memory_sync_reflections: 1,
  });
});

afterAll(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('CI_SERVER_URL', SAVED.url);
  restore('CI_SERVER_API_KEY', SAVED.apiKey);
  restore('MEMORY_MODE', SAVED.mode);
  // resetDb keeps the scheduling_prefs ROW and does NOT own the push-side fields, so a
  // file that runs later over this shared sequential DB (e.g. graphql-prefs) would see
  // our enabled+connected state leak. Pin them back to schema defaults on the way out —
  // the same courtesy memory-connector.test.ts extends.
  sqlite.exec(`
    UPDATE scheduling_prefs SET
      memory_sync_enabled = 0,
      memory_account = NULL,
      memory_last_synced_at = NULL,
      memory_sync_completed = 1,
      memory_sync_habits = 1,
      memory_sync_reflections = 1;
  `);
});

describe('guards', () => {
  it('returns disabled when the sync flag is off (no watermark stamped)', async () => {
    setPrefs({ memory_sync_enabled: 0 });
    expect(await syncToMemory(OWNER)).toEqual({ ok: false, reason: 'disabled' });
    expect(lastSyncedAt()).toBeNull();
  });

  it('returns not_connected when enabled but no account', async () => {
    setPrefs({ memory_account: null });
    expect(await syncToMemory(OWNER)).toEqual({ ok: false, reason: 'not_connected' });
    expect(lastSyncedAt()).toBeNull();
  });

  it('returns unavailable when connected but no creds resolve', async () => {
    delete process.env.CI_SERVER_URL; // no settings row + no env → creds null
    expect(await syncToMemory(OWNER)).toEqual({ ok: false, reason: 'unavailable' });
    expect(lastSyncedAt()).toBeNull();
  });
});

describe('event building + push (fixture, no network)', () => {
  it('pushes completed tasks, habit occurrences, and reflections, then stamps the watermark', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    insertDoneTask('Write the report', recent, { estimated_minutes: 45, actual_minutes: 50 });
    const habitTask = insertDoneTask('Meditate', recent);
    makeHabitPattern('Meditate', [habitTask]);
    insertReflection('day_note', '2026-07-06', 'Solid day', recent);
    insertReflection('evening', '2026-07-06', 'Wound down well', recent);

    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The Meditate habit is pushed as habit_done and EXCLUDED from completed (no double-push).
    expect(r.counts).toMatchObject({ completed: 1, habits: 1, reflections: 2 });
    // Fixture: every built event counts as ingested.
    expect(r.counts.ingested).toBe(4);
    expect(r.counts.duplicate).toBe(0);
    expect(r.counts.rejected).toBe(0);
    expect(lastSyncedAt()).toBe(r.syncedAt);
  });

  it('a completed task pushes even with no habit membership; payload carries actuals only when present', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    insertDoneTask('Plain task', recent); // actual_minutes defaults to 0 → omitted from payload
    const r = await syncToMemory(OWNER);
    expect(r.ok && r.counts).toMatchObject({ completed: 1, habits: 0, reflections: 0, ingested: 1 });
  });

  it('an empty owner pushes nothing but still succeeds and stamps', async () => {
    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.counts).toMatchObject({ completed: 0, habits: 0, reflections: 0, ingested: 0 });
      expect(lastSyncedAt()).toBe(r.syncedAt);
    }
  });
});

describe('scope gating', () => {
  const seed = () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const habitTask = insertDoneTask('Meditate', recent);
    makeHabitPattern('Meditate', [habitTask]);
    insertDoneTask('Non-habit task', recent);
    insertReflection('day_note', '2026-07-06', 'note', recent);
  };

  it('habits off → no habit events; the completed habit task falls through the completed scope', async () => {
    seed();
    setPrefs({ memory_sync_habits: 0 });
    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.counts.habits).toBe(0);
      // With habits off, BOTH the habit task and the plain task are plain completions.
      expect(r.counts.completed).toBe(2);
    }
  });

  it('completed off → no task_completed events (habit_done still flows)', async () => {
    seed();
    setPrefs({ memory_sync_completed: 0 });
    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.counts.completed).toBe(0);
      expect(r.counts.habits).toBe(1);
    }
  });

  it('reflections off → no reflection events', async () => {
    seed();
    setPrefs({ memory_sync_reflections: 0 });
    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.counts.reflections).toBe(0);
  });

  it('all scopes off → succeeds with zero events, still stamps', async () => {
    seed();
    setPrefs({ memory_sync_completed: 0, memory_sync_habits: 0, memory_sync_reflections: 0 });
    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.counts).toMatchObject({ completed: 0, habits: 0, reflections: 0 });
      expect(lastSyncedAt()).toBe(r.syncedAt);
    }
  });
});

describe('watermark', () => {
  it('a task completed BEFORE memory_last_synced_at is not re-pushed', async () => {
    const watermark = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago
    setPrefs({ memory_last_synced_at: watermark });
    // Completed 2h ago (before the watermark) → excluded.
    insertDoneTask('Old task', new Date(Date.now() - 2 * 3_600_000).toISOString());
    // Completed just now (after the watermark) → included.
    insertDoneTask('Fresh task', new Date(Date.now() - 60_000).toISOString());

    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.counts.completed).toBe(1);
  });

  it('reflections use updated_at against the watermark', async () => {
    const watermark = new Date(Date.now() - 3_600_000).toISOString();
    setPrefs({ memory_last_synced_at: watermark });
    insertReflection('day_note', '2026-07-05', 'stale', new Date(Date.now() - 2 * 3_600_000).toISOString());
    insertReflection('evening', '2026-07-06', 'fresh', new Date(Date.now() - 60_000).toISOString());
    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.counts.reflections).toBe(1);
  });

  it('the stamped watermark is captured BEFORE the push, so an event that occurs during the sync is re-picked next run (no skip)', async () => {
    // First sync: nothing to push. The watermark it stamps is an instant captured
    // BEFORE the (empty) SELECT — this is the anti-data-loss guarantee.
    const first = await syncToMemory(OWNER);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stamped = first.syncedAt;
    expect(lastSyncedAt()).toBe(stamped);

    // Simulate a task that completed "during" the sync: its completed_at is AFTER the
    // stamped watermark (as a post-push `now` stamp would have been). Because the
    // watermark was taken pre-SELECT, this row is strictly > the stored watermark and
    // MUST be selected on the next run — never skipped.
    const during = new Date(Date.parse(stamped) + 5).toISOString();
    insertDoneTask('Completed during the sync', during);

    // Next run MUST pick it up — this is the regression guard. (Had the first run stamped
    // a post-push `now` instead of the pre-SELECT instant, that `now` would be >= `during`
    // and the row would be skipped forever.)
    const second = await syncToMemory(OWNER);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.counts.completed).toBe(1);

    // Forward progress: once the watermark is at/after `during`, a further run with no new
    // activity re-pushes nothing (no infinite re-push loop). Pin the watermark explicitly
    // rather than racing the fixture-mode wall clock, which advances sub-millisecond.
    setPrefs({ memory_last_synced_at: during });
    const third = await syncToMemory(OWNER);
    expect(third.ok && third.counts.completed).toBe(0);
  });

  it('on a first sync (null watermark) only the recent window is considered', async () => {
    // No prior sync → INITIAL_WINDOW_DAYS (30) back. A 90-day-old completion is excluded.
    insertDoneTask('Ancient task', new Date(Date.now() - 90 * 86_400_000).toISOString());
    insertDoneTask('Recent task', new Date(Date.now() - 60_000).toISOString());
    const r = await syncToMemory(OWNER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.counts.completed).toBe(1);
  });
});

describe('scheduled job (push_memory)', () => {
  it('the migration seeded the daily push_memory job', () => {
    const row = sqlite
      .prepare(`SELECT kind, cron, enabled FROM scheduled_jobs WHERE kind = 'push_memory'`)
      .get() as { kind: string; cron: string; enabled: number };
    expect(row).toMatchObject({ kind: 'push_memory', cron: '0 2 * * *', enabled: 1 });
  });

  it('runScheduledJob pushes per owner and records a done job run', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    insertDoneTask('Job task', recent);
    await runScheduledJob('push_memory');
    const jr = sqlite
      .prepare(
        `SELECT jr.status, jr.items_updated, jr.log FROM job_runs jr
           JOIN scheduled_jobs sj ON sj.id = jr.job_id
          WHERE sj.kind = 'push_memory' ORDER BY jr.started_at DESC LIMIT 1`,
      )
      .get() as { status: string; items_updated: number; log: string };
    expect(jr.status).toBe('done');
    expect(jr.items_updated).toBe(1);
    expect(jr.log).toContain('Pushed 1 event');
    // The job path stamps the watermark for the owner.
    expect(lastSyncedAt()).not.toBeNull();
  });

  it('flag off → the job is a clean no-op log (status done, not error)', async () => {
    setPrefs({ memory_sync_enabled: 0 });
    await runScheduledJob('push_memory');
    const jr = sqlite
      .prepare(
        `SELECT jr.status, jr.log FROM job_runs jr
           JOIN scheduled_jobs sj ON sj.id = jr.job_id
          WHERE sj.kind = 'push_memory' ORDER BY jr.started_at DESC LIMIT 1`,
      )
      .get() as { status: string; log: string };
    expect(jr.status).toBe('done');
    expect(jr.log).toContain('disabled');
    expect(lastSyncedAt()).toBeNull();
  });
});
