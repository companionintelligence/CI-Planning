import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, createOwner, SECOND_OWNER_ID } from './helpers.js';
import {
  weekBoundsFor,
  scheduledMinutesByDimension,
  dimensionShortfalls,
  biasLeadDimensions,
  SHORTFALL_FLOOR_HOURS,
  BIAS_DIMENSIONS_MAX,
  type DimensionShortfall,
} from '../src/services/balance-budget.js';

/**
 * Ticket 1 of the balance-targets wave
 * (docs/factory/balance-targets-wave/bal-1-shortfall-service.md): the shortfall
 * service's own unit tests, direct against the module (no HTTP server — this ticket
 * ships no route). Fixtures inserted with raw `sqlite` exactly like
 * triality-vector.test.ts, since `resetDb` wipes `tags`/`entity_categories`/
 * `life_priorities`/`time_blocks` and each file re-seeds what it needs (0134 shape).
 */

const OWNER = SYSTEM_OWNER;
const ANCHOR = '2026-08-29'; // Saturday — week-of Mon 2026-08-24 .. Sun 2026-08-30

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

function insertBlock(
  startAt: string,
  endAt: string,
  o: { status?: string; taskId?: string | null; owner?: string } = {},
): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, start_at, end_at, status, task_id)
         VALUES (uuid7(), ?, 'fixture', ?, ?, ?, ?) RETURNING id`,
      )
      .get(o.owner ?? OWNER, startAt, endAt, o.status ?? 'planned', o.taskId ?? null) as { id: string }
  ).id;
}

function setPriority(category: string, targetHoursPerWeek: number, owner: string = OWNER): void {
  sqlite
    .prepare(`INSERT INTO life_priorities (id, owner_id, category, target_hours_per_week) VALUES (uuid7(), ?, ?, ?)`)
    .run(owner, category, targetHoursPerWeek);
}

describe('weekBoundsFor', () => {
  it('a Saturday anchor maps to that week\'s Monday', () => {
    const { weekStart, startUtc, endUtc } = weekBoundsFor(ANCHOR);
    expect(weekStart).toBe('2026-08-24');
    expect(startUtc).toBe('2026-08-24T00:00:00.000Z');
    expect(endUtc).toBe('2026-08-30T23:59:59.999Z');
  });

  it('a Sunday anchor maps to the PRECEDING Monday (dow===0 branch)', () => {
    const { weekStart } = weekBoundsFor('2026-08-30'); // Sunday
    expect(weekStart).toBe('2026-08-24');
  });
});

describe('scheduledMinutesByDimension — derive rule', () => {
  it('a block with its own categories uses them; a task-backed block with none inherits the task\'s', async () => {
    const health = seedCategory('health');
    const career = seedCategory('career');

    // Own categories win outright, even though its task has a different one.
    const task1 = insertTask();
    categorize('task', task1, career);
    const ownBlock = insertBlock('2026-08-25T09:00:00.000Z', '2026-08-25T10:00:00.000Z', { taskId: task1 });
    categorize('time_block', ownBlock, health);

    // No own categories: inherits the task's.
    const task2 = insertTask();
    categorize('task', task2, career);
    insertBlock('2026-08-26T09:00:00.000Z', '2026-08-26T10:00:00.000Z', { taskId: task2 });

    const minutes = await scheduledMinutesByDimension(OWNER, ANCHOR);
    expect(minutes.get('health')).toBe(60);
    expect(minutes.get('career')).toBe(60);
  });

  it('cancelled/skipped/missed blocks contribute 0; completed contributes fully', async () => {
    const health = seedCategory('health');
    for (const status of ['cancelled', 'skipped', 'missed']) {
      const b = insertBlock('2026-08-25T09:00:00.000Z', '2026-08-25T10:00:00.000Z', { status });
      categorize('time_block', b, health);
    }
    const done = insertBlock('2026-08-26T09:00:00.000Z', '2026-08-26T10:00:00.000Z', { status: 'completed' });
    categorize('time_block', done, health);

    const minutes = await scheduledMinutesByDimension(OWNER, ANCHOR);
    expect(minutes.get('health')).toBe(60); // only the completed block's 60 minutes
  });

  it('a block spanning the week edge contributes only its clamped in-week minutes', async () => {
    const health = seedCategory('health');
    // Starts Sunday (prior week) 22:00Z, ends Monday (this week) 02:00Z: only the
    // 2 in-week hours (00:00-02:00 Monday) should count.
    const spanning = insertBlock('2026-08-23T22:00:00.000Z', '2026-08-24T02:00:00.000Z');
    categorize('time_block', spanning, health);

    const minutes = await scheduledMinutesByDimension(OWNER, ANCHOR);
    expect(minutes.get('health')).toBe(120);
  });

  it('a two-category block counts its full minutes in both dimensions (no splitting)', async () => {
    const health = seedCategory('health');
    const career = seedCategory('career');
    const b = insertBlock('2026-08-25T09:00:00.000Z', '2026-08-25T10:30:00.000Z');
    categorize('time_block', b, health, 0);
    categorize('time_block', b, career, 1);

    const minutes = await scheduledMinutesByDimension(OWNER, ANCHOR);
    expect(minutes.get('health')).toBe(90);
    expect(minutes.get('career')).toBe(90);
  });
});

describe('dimensionShortfalls', () => {
  it('target 14h, 4h scheduled -> shortfall 600; target 0 -> shortfall 0', async () => {
    const health = seedCategory('health');
    const finance = seedCategory('finance');
    setPriority('health', 14);
    setPriority('finance', 0);

    const b = insertBlock('2026-08-25T09:00:00.000Z', '2026-08-25T13:00:00.000Z'); // 4h
    categorize('time_block', b, health);
    // finance has no blocks at all this week.
    void finance;

    const shortfalls = await dimensionShortfalls(OWNER, ANCHOR);
    const healthRow = shortfalls.find((s) => s.category === 'health')!;
    const financeRow = shortfalls.find((s) => s.category === 'finance')!;
    expect(healthRow).toMatchObject({ target_hours: 14, scheduled_minutes: 240, shortfall_minutes: 600 });
    expect(financeRow).toMatchObject({ target_hours: 0, scheduled_minutes: 0, shortfall_minutes: 0 });
  });

  it('returns [] and does not throw when the owner has no life_priorities rows', async () => {
    const shortfalls = await dimensionShortfalls(OWNER, ANCHOR);
    expect(shortfalls).toEqual([]);
  });

  it('sorts shortfall-desc then category asc', async () => {
    setPriority('leisure', 5); // 300 min shortfall, nothing scheduled
    setPriority('career', 5); // 300 min shortfall, nothing scheduled — ties with leisure
    setPriority('growth', 10); // 600 min shortfall

    const shortfalls = await dimensionShortfalls(OWNER, ANCHOR);
    expect(shortfalls.map((s) => s.category)).toEqual(['growth', 'career', 'leisure']);
  });
});

describe('biasLeadDimensions', () => {
  const row = (category: string, shortfallHours: number): DimensionShortfall => ({
    category,
    target_hours: shortfallHours,
    scheduled_minutes: 0,
    shortfall_minutes: shortfallHours * 60,
  });

  it('the floor excludes a 1.9h shortfall', () => {
    expect(SHORTFALL_FLOOR_HOURS).toBe(2);
    const shortfalls = [row('growth', 5), row('health', 1.9)];
    expect(biasLeadDimensions(shortfalls)).toEqual(['growth']);
  });

  it('the cap returns 2 of 3 eligible dimensions, worst-first', () => {
    expect(BIAS_DIMENSIONS_MAX).toBe(2);
    // Already worst-first, as dimensionShortfalls would return it.
    const shortfalls = [row('growth', 10), row('health', 6), row('career', 3)];
    expect(biasLeadDimensions(shortfalls)).toEqual(['growth', 'health']);
  });
});

describe('owner isolation', () => {
  it('owner B\'s blocks and targets never leak into owner A\'s numbers', async () => {
    createOwner(SECOND_OWNER_ID);
    const healthA = seedCategory('health', OWNER);
    const healthB = seedCategory('health', SECOND_OWNER_ID);
    setPriority('health', 14, OWNER);
    setPriority('health', 3, SECOND_OWNER_ID);

    const blockA = insertBlock('2026-08-25T09:00:00.000Z', '2026-08-25T10:00:00.000Z', { owner: OWNER });
    categorize('time_block', blockA, healthA);
    const blockB = insertBlock('2026-08-25T09:00:00.000Z', '2026-08-25T13:00:00.000Z', { owner: SECOND_OWNER_ID });
    categorize('time_block', blockB, healthB);

    const minutesA = await scheduledMinutesByDimension(OWNER, ANCHOR);
    const minutesB = await scheduledMinutesByDimension(SECOND_OWNER_ID, ANCHOR);
    expect(minutesA.get('health')).toBe(60);
    expect(minutesB.get('health')).toBe(240);

    const shortfallsA = await dimensionShortfalls(OWNER, ANCHOR);
    const shortfallsB = await dimensionShortfalls(SECOND_OWNER_ID, ANCHOR);
    expect(shortfallsA).toHaveLength(1);
    expect(shortfallsA[0]).toMatchObject({ target_hours: 14, scheduled_minutes: 60 });
    expect(shortfallsB).toHaveLength(1);
    expect(shortfallsB[0]).toMatchObject({ target_hours: 3, scheduled_minutes: 240 });
  });
});
