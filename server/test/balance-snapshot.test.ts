import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, createOwner, SECOND_OWNER_ID, startTestServer, api, type TestServer } from './helpers.js';
import { snapshotBalanceWeek } from '../src/services/balance-snapshot.js';

/**
 * Ticket 6 of the balance-targets wave
 * (docs/factory/balance-targets-wave/bal-6-week-log.md): `snapshotBalanceWeek`'s own
 * unit tests, direct against the module (no HTTP server for the job itself — this
 * ticket ships no route) plus one round-trip test against the export/import HTTP API.
 * Fixtures inserted with raw `sqlite`, matching balance-budget.test.ts's convention.
 *
 * NOW is a Saturday in the week-of Mon 2026-08-24..Sun 2026-08-30 (the same anchor week
 * balance-budget.test.ts uses); "previous completed week" from here is Mon
 * 2026-08-17..Sun 2026-08-23.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-08-29T10:00:00.000Z');
const PREV_WEEK_START = '2026-08-17';

beforeEach(() => resetDb());

function insertTask(owner: string = OWNER): string {
  return (
    sqlite.prepare(`INSERT INTO tasks (id, title, owner_id) VALUES (uuid7(), 'fixture', ?) RETURNING id`).get(owner) as {
      id: string;
    }
  ).id;
}

function seedCategory(name: string, owner: string = OWNER): string {
  return (
    sqlite
      .prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'category', 1) RETURNING id`)
      .get(owner, name) as { id: string }
  ).id;
}

function categorize(entityKind: 'task' | 'time_block', entityId: string, categoryTagId: string, position = 0): void {
  sqlite
    .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES (?, ?, ?, ?)`)
    .run(entityKind, entityId, categoryTagId, position);
}

function insertBlock(startAt: string, endAt: string, o: { taskId?: string | null; owner?: string } = {}): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, start_at, end_at, status, task_id)
         VALUES (uuid7(), ?, 'fixture', ?, ?, 'planned', ?) RETURNING id`,
      )
      .get(o.owner ?? OWNER, startAt, endAt, o.taskId ?? null) as { id: string }
  ).id;
}

function insertTimeEntry(taskId: string, startedAt: string, endedAt: string | null, owner: string = OWNER): string {
  return (
    sqlite
      .prepare(`INSERT INTO time_entries (id, owner_id, task_id, started_at, ended_at) VALUES (uuid7(), ?, ?, ?, ?) RETURNING id`)
      .get(owner, taskId, startedAt, endedAt) as { id: string }
  ).id;
}

function setPriority(category: string, targetHoursPerWeek: number, owner: string = OWNER): void {
  sqlite
    .prepare(`INSERT INTO life_priorities (id, owner_id, category, target_hours_per_week) VALUES (uuid7(), ?, ?, ?)`)
    .run(owner, category, targetHoursPerWeek);
}

function logRows(owner: string = OWNER): { category: string; target_hours: number; scheduled_minutes: number; timed_minutes: number }[] {
  return sqlite
    .prepare(
      `SELECT category, target_hours, scheduled_minutes, timed_minutes
         FROM balance_week_log WHERE owner_id = ? AND week_start = ? ORDER BY category`,
    )
    .all(owner, PREV_WEEK_START) as { category: string; target_hours: number; scheduled_minutes: number; timed_minutes: number }[];
}

describe('snapshotBalanceWeek', () => {
  it('freezes target/scheduled/timed correctly per dimension for the previous completed week', async () => {
    const health = seedCategory('health');
    seedCategory('finance');
    setPriority('health', 5);
    setPriority('finance', 0);

    // Scheduled: a 2h block inside the previous week.
    const block = insertBlock('2026-08-18T09:00:00.000Z', '2026-08-18T11:00:00.000Z');
    categorize('time_block', block, health);

    // Timed: a 1.5h finished entry on a health-categorized task, inside the previous week.
    const task = insertTask();
    categorize('task', task, health);
    insertTimeEntry(task, '2026-08-19T09:00:00.000Z', '2026-08-19T10:30:00.000Z');

    const result = await snapshotBalanceWeek(OWNER, NOW);
    expect(result).toEqual({ weekStart: PREV_WEEK_START, rows: 2 });

    const rows = logRows();
    expect(rows).toEqual([
      { category: 'finance', target_hours: 0, scheduled_minutes: 0, timed_minutes: 0 },
      { category: 'health', target_hours: 5, scheduled_minutes: 120, timed_minutes: 90 },
    ]);
  });

  it('a block or entry outside the previous week is excluded', async () => {
    const health = seedCategory('health');
    setPriority('health', 5);

    // In the CURRENT week (2026-08-24..30), not the previous one — must not count.
    const block = insertBlock('2026-08-25T09:00:00.000Z', '2026-08-25T11:00:00.000Z');
    categorize('time_block', block, health);
    const task = insertTask();
    categorize('task', task, health);
    insertTimeEntry(task, '2026-08-26T09:00:00.000Z', '2026-08-26T10:00:00.000Z');

    const result = await snapshotBalanceWeek(OWNER, NOW);
    expect(result.rows).toBe(1);
    expect(logRows()).toEqual([{ category: 'health', target_hours: 5, scheduled_minutes: 0, timed_minutes: 0 }]);
  });

  it('re-run of the same week inserts 0 new rows; a later calendar edit does not change the frozen row', async () => {
    const health = seedCategory('health');
    setPriority('health', 5);
    const block = insertBlock('2026-08-18T09:00:00.000Z', '2026-08-18T11:00:00.000Z'); // 2h
    categorize('time_block', block, health);

    const first = await snapshotBalanceWeek(OWNER, NOW);
    expect(first).toEqual({ weekStart: PREV_WEEK_START, rows: 1 });
    expect(logRows()).toEqual([{ category: 'health', target_hours: 5, scheduled_minutes: 120, timed_minutes: 0 }]);

    // Re-run with nothing changed: 0 new rows.
    const rerun = await snapshotBalanceWeek(OWNER, NOW);
    expect(rerun).toEqual({ weekStart: PREV_WEEK_START, rows: 0 });

    // Edit the calendar retroactively (add another 3h to the already-frozen week), then
    // re-run: still 0 new rows, and the frozen row's scheduled_minutes is UNCHANGED.
    const extra = insertBlock('2026-08-20T09:00:00.000Z', '2026-08-20T12:00:00.000Z'); // 3h
    categorize('time_block', extra, health);

    const afterEdit = await snapshotBalanceWeek(OWNER, NOW);
    expect(afterEdit).toEqual({ weekStart: PREV_WEEK_START, rows: 0 });
    expect(logRows()).toEqual([{ category: 'health', target_hours: 5, scheduled_minutes: 120, timed_minutes: 0 }]);
  });

  it('an owner with no life_priorities rows yields rows: 0 and does not throw', async () => {
    await expect(snapshotBalanceWeek(OWNER, NOW)).resolves.toEqual({ weekStart: PREV_WEEK_START, rows: 0 });
    expect(logRows()).toEqual([]);
  });

  it('owner isolation: one owner\'s targets/calendar never leak into another\'s frozen row', async () => {
    createOwner(SECOND_OWNER_ID);
    const healthA = seedCategory('health', OWNER);
    const healthB = seedCategory('health', SECOND_OWNER_ID);
    setPriority('health', 14, OWNER);
    setPriority('health', 3, SECOND_OWNER_ID);

    const blockA = insertBlock('2026-08-18T09:00:00.000Z', '2026-08-18T10:00:00.000Z', { owner: OWNER }); // 1h
    categorize('time_block', blockA, healthA);
    const blockB = insertBlock('2026-08-18T09:00:00.000Z', '2026-08-18T13:00:00.000Z', { owner: SECOND_OWNER_ID }); // 4h
    categorize('time_block', blockB, healthB);

    const resultA = await snapshotBalanceWeek(OWNER, NOW);
    const resultB = await snapshotBalanceWeek(SECOND_OWNER_ID, NOW);
    expect(resultA.rows).toBe(1);
    expect(resultB.rows).toBe(1);

    expect(logRows(OWNER)).toEqual([{ category: 'health', target_hours: 14, scheduled_minutes: 60, timed_minutes: 0 }]);
    expect(logRows(SECOND_OWNER_ID)).toEqual([{ category: 'health', target_hours: 3, scheduled_minutes: 240, timed_minutes: 0 }]);
  });
});

describe('balance_week_log — backup export/import round-trip', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });

  it('carries frozen rows through export -> wipe -> import unchanged', async () => {
    const { id: ownerId } = sqlite.prepare('SELECT id FROM owners LIMIT 1').get() as { id: string };
    sqlite
      .prepare(
        `INSERT INTO balance_week_log
           (id, owner_id, week_start, category, target_hours, scheduled_minutes, timed_minutes, created_at)
         VALUES (uuid7(), ?, ?, 'health', 5, 120, 90, '2026-08-24T04:40:00.000Z')`,
      )
      .run(ownerId, PREV_WEEK_START);

    const exported = (await (await fetch(`${srv.url}/api/export`)).json()) as Record<string, unknown>;
    expect(Array.isArray(exported.balance_week_log)).toBe(true);
    expect((exported.balance_week_log as { category: string }[]).some((r) => r.category === 'health')).toBe(true);

    resetDb();
    expect((sqlite.prepare('SELECT count(*) AS n FROM balance_week_log').get() as { n: number }).n).toBe(0);

    const { status, body } = await api<{ imported: Record<string, number> }>(
      srv.url,
      '/api/import',
      { method: 'POST', json: exported },
    );
    expect(status).toBe(200);
    expect(body.imported.balance_week_log).toBe(1);

    const row = sqlite
      .prepare(
        `SELECT week_start, category, target_hours, scheduled_minutes, timed_minutes
           FROM balance_week_log WHERE category = 'health'`,
      )
      .get() as { week_start: string; category: string; target_hours: number; scheduled_minutes: number; timed_minutes: number } | undefined;
    expect(row).toEqual({
      week_start: PREV_WEEK_START,
      category: 'health',
      target_hours: 5,
      scheduled_minutes: 120,
      timed_minutes: 90,
    });
  });
});
