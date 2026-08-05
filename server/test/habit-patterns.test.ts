import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { ensureHabitPattern } from '../src/services/patterns.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Habit → Pattern bridge (G2 / E′). `ensureHabitPattern` keeps habit tasks in sync
 * with Habit-type patterns; the create path calls it on every new habit recurring task.
 * (The 0014 migration ran the bulk backfill; 0048 dropped is_habit so the migration
 * can no longer be called directly against the current schema.)
 */

const OWNER = SYSTEM_OWNER;

const habitTypeId = () =>
  (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND is_builtin = 1 AND owner_id = ?`).get(OWNER) as { id: string }).id;

const insertHabitTemplate = (title: string): string =>
  (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, subtype, recurrence_rule, recurrence_dtstart)
         VALUES (uuid7(), ?, ?, 'recurring', 'habit', 'FREQ=DAILY', '2026-06-01T12:00:00.000Z') RETURNING id`
      )
      .get(title, OWNER) as { id: string }
  ).id;

const habitPatternsFor = (taskId: string) =>
  sqlite
    .prepare(
      `SELECT p.id, p.name FROM patterns p JOIN pattern_tasks pt ON pt.pattern_id = p.id
        WHERE pt.task_id = ? AND p.type_id = ?`
    )
    .all(taskId, habitTypeId()) as { id: string; name: string }[];

beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM pattern_tasks; DELETE FROM patterns; DELETE FROM pattern_types WHERE is_builtin = 0;`);
});

describe('habit → pattern bridge', () => {
  it('ensureHabitPattern links a habit to a Habit-type pattern, idempotently', async () => {
    const t = insertHabitTemplate('Meditate');
    await ensureHabitPattern(t, OWNER, 'Meditate');
    expect(habitPatternsFor(t).map((p) => p.name)).toEqual(['Meditate']);
    await ensureHabitPattern(t, OWNER, 'Meditate'); // again
    expect(habitPatternsFor(t).length).toBe(1); // no duplicate
  });

  it('ensureHabitPattern links multiple habit templates, idempotently', async () => {
    const a = insertHabitTemplate('Stretch');
    const b = insertHabitTemplate('Read');
    await ensureHabitPattern(a, OWNER, 'Stretch');
    await ensureHabitPattern(b, OWNER, 'Read');
    expect(habitPatternsFor(a).length).toBe(1);
    expect(habitPatternsFor(b).length).toBe(1);
    await ensureHabitPattern(a, OWNER, 'Stretch'); // re-run is a no-op
    expect(habitPatternsFor(a).length).toBe(1);
  });

  it('ensureHabitPattern does not affect unrelated instances', async () => {
    const tpl = insertHabitTemplate('Walk');
    const inst = (
      sqlite
        .prepare(
          `INSERT INTO tasks (id, title, owner_id, status, subtype, recurrence_parent_id, occurrence_date)
           VALUES (uuid7(), 'Walk', ?, 'open', 'habit', ?, '2026-06-10') RETURNING id`
        )
        .get(OWNER, tpl) as { id: string }
    ).id;
    await ensureHabitPattern(tpl, OWNER, 'Walk');
    expect(habitPatternsFor(tpl).length).toBe(1);
    expect(habitPatternsFor(inst).length).toBe(0); // never called for instance
  });
});

describe('routes — creating a habit syncs a pattern', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it('POST /api/tasks (recurrence_rule + is_habit) creates a linked Habit pattern', async () => {
    const { status, body } = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Journal', recurrence_rule: 'FREQ=DAILY', is_habit: true },
    });
    expect(status).toBe(201);
    expect(habitPatternsFor(body.task.id).map((p) => p.name)).toEqual(['Journal']);
  });

  it('a non-habit recurring task creates no Habit pattern', async () => {
    const { body } = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Standup', recurrence_rule: 'FREQ=DAILY', is_habit: false },
    });
    expect(habitPatternsFor(body.task.id).length).toBe(0);
  });
});
