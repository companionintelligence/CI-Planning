import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { ensureHabitPattern } from '../src/services/patterns.js';
import { up as backfillHabits } from '../src/db/migrations/0014_habit_patterns_backfill.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Habit → Pattern bridge (G2 / E′). The migration backfills existing habits to
 * Habit-type patterns and the create path keeps new ones in sync; `is_habit` stays
 * the runtime flag (E behaviour unchanged — covered by the recurrence suites).
 */

const OWNER = SYSTEM_OWNER;

const habitTypeId = () =>
  (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND is_builtin = 1 AND owner_id = ?`).get(OWNER) as { id: string }).id;

const insertHabitTemplate = (title: string): string =>
  (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, is_habit, recurrence_rule, recurrence_dtstart)
         VALUES (uuid7(), ?, ?, 'recurring', 1, 'FREQ=DAILY', '2026-06-01T12:00:00.000Z') RETURNING id`
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
  it('ensureHabitPattern links a habit to a Habit-type pattern, idempotently', () => {
    const t = insertHabitTemplate('Meditate');
    ensureHabitPattern(t, OWNER, 'Meditate');
    expect(habitPatternsFor(t).map((p) => p.name)).toEqual(['Meditate']);
    ensureHabitPattern(t, OWNER, 'Meditate'); // again
    expect(habitPatternsFor(t).length).toBe(1); // no duplicate
  });

  it('the 0014 backfill links existing habit templates, idempotently', () => {
    const a = insertHabitTemplate('Stretch');
    const b = insertHabitTemplate('Read');
    backfillHabits(sqlite);
    expect(habitPatternsFor(a).length).toBe(1);
    expect(habitPatternsFor(b).length).toBe(1);
    backfillHabits(sqlite); // re-run is a no-op
    expect(habitPatternsFor(a).length).toBe(1);
  });

  it('backfills templates only, not instances', () => {
    const tpl = insertHabitTemplate('Walk');
    const inst = (
      sqlite
        .prepare(
          `INSERT INTO tasks (id, title, owner_id, status, is_habit, recurrence_parent_id, occurrence_date)
           VALUES (uuid7(), 'Walk', ?, 'open', 1, ?, '2026-06-10') RETURNING id`
        )
        .get(OWNER, tpl) as { id: string }
    ).id;
    backfillHabits(sqlite);
    expect(habitPatternsFor(tpl).length).toBe(1);
    expect(habitPatternsFor(inst).length).toBe(0);
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
