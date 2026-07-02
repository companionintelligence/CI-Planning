import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { weeklyReview } from '../src/services/weekly-review.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb } from './helpers.js';

// Anchor: Wednesday 2026-06-17 — week spans Mon 2026-06-15 to Sun 2026-06-21
const ANCHOR = '2026-06-17';
const WEEK_KEY = '2026-W25';
const MON = '2026-06-15';
const SUN = '2026-06-21';

function insertTask(
  title: string,
  opts: { dueAt?: string; completedAt?: string; status?: string; estimatedMinutes?: number } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, due_at, completed_at, estimated_minutes)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      title,
      SYSTEM_OWNER,
      opts.status ?? 'open',
      opts.dueAt ?? null,
      opts.completedAt ?? null,
      opts.estimatedMinutes ?? null,
    );
}

function insertBlock(startAt: string, endAt: string) {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, status, owner_id)
       VALUES (uuid7(), 'Block', 'task', ?, ?, 'done', ?)`,
    )
    .run(startAt, endAt, SYSTEM_OWNER);
}

function insertWeeklyGoal(position: number, body: string, doneAt: string | null = null) {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, done_at, created_at, updated_at)
       VALUES (?, 'weekly_goal', ?, ?, ?, ?, ?, ?)`,
    )
    .run(SYSTEM_OWNER, WEEK_KEY, position, body, doneAt, now, now);
}

function insertObjective(progressCache: number | null = null) {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, progress_cache, created_at, updated_at)
       VALUES (uuid7(), ?, 'Test Obj', 'goal', 'none', 'active', 'none', ?, ?, ?)`,
    )
    .run(SYSTEM_OWNER, progressCache, now, now);
}

describe('weeklyReview', () => {
  beforeEach(() => {
    resetDb();
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(SYSTEM_OWNER);
  });

  it('returns correct week_key and seven days Mon→Sun', () => {
    const r = weeklyReview(ANCHOR);
    expect(r.week_key).toBe(WEEK_KEY);
    expect(r.days).toHaveLength(7);
    expect(r.days[0]).toBe(MON);
    expect(r.days[6]).toBe(SUN);
  });

  it('empty week returns all zeros and no weekly_goals', () => {
    const r = weeklyReview(ANCHOR);
    expect(r.tasks_completed).toBe(0);
    expect(r.tasks_overdue).toBe(0);
    expect(r.blocks_count).toBe(0);
    expect(r.weekly_goals).toEqual([]);
    expect(r.objectives_rotting).toBe(0);
  });

  it('counts tasks completed within the week', () => {
    // Completed Mon in the week
    insertTask('A', { status: 'done', completedAt: `${MON}T10:00:00.000Z` });
    // Completed Wed in the week
    insertTask('B', { status: 'done', completedAt: `${ANCHOR}T14:00:00.000Z` });
    // Completed before the week (should not count)
    insertTask('C', { status: 'done', completedAt: '2026-06-13T09:00:00.000Z' });
    // Completed after the week (should not count)
    insertTask('D', { status: 'done', completedAt: '2026-06-22T09:00:00.000Z' });

    const r = weeklyReview(ANCHOR);
    expect(r.tasks_completed).toBe(2);
  });

  it('counts tasks with due_at in the week that remain open', () => {
    // Due in week, still open
    insertTask('Overdue A', { dueAt: `${MON}T12:00:00.000Z`, status: 'open' });
    insertTask('Overdue B', { dueAt: `${SUN}T12:00:00.000Z`, status: 'open' });
    // Due in week but completed → not overdue
    insertTask('Done C', { dueAt: `${ANCHOR}T12:00:00.000Z`, status: 'done', completedAt: `${ANCHOR}T14:00:00.000Z` });
    // Due outside week
    insertTask('Future D', { dueAt: '2026-06-25T12:00:00.000Z', status: 'open' });

    const r = weeklyReview(ANCHOR);
    expect(r.tasks_overdue).toBe(2);
  });

  it('counts time blocks whose start falls within the week', () => {
    insertBlock(`${MON}T09:00:00.000Z`, `${MON}T10:00:00.000Z`);   // Mon, in week
    insertBlock(`${SUN}T14:00:00.000Z`, `${SUN}T15:00:00.000Z`);   // Sun, in week
    insertBlock('2026-06-14T09:00:00.000Z', '2026-06-14T10:00:00.000Z'); // Sun before, out
    insertBlock('2026-06-22T09:00:00.000Z', '2026-06-22T10:00:00.000Z'); // Mon after, out

    const r = weeklyReview(ANCHOR);
    expect(r.blocks_count).toBe(2);
  });

  it('returns weekly_goals for the week with done_at preserved', () => {
    insertWeeklyGoal(0, 'Finish the N1 spec', null);
    insertWeeklyGoal(1, 'Ship the PR', '2026-06-16T10:00:00.000Z');

    const r = weeklyReview(ANCHOR);
    expect(r.weekly_goals).toHaveLength(2);
    expect(r.weekly_goals[0].position).toBe(0);
    expect(r.weekly_goals[0].body).toBe('Finish the N1 spec');
    expect(r.weekly_goals[0].done_at).toBeNull();
    expect(r.weekly_goals[1].done_at).not.toBeNull();
  });

  it('ignores weekly_goals from other weeks', () => {
    insertWeeklyGoal(0, 'This week goal', null);
    const otherNow = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
         VALUES (?, 'weekly_goal', '2026-W24', 0, 'Last week goal', ?, ?)`,
      )
      .run(SYSTEM_OWNER, otherNow, otherNow);

    const r = weeklyReview(ANCHOR);
    expect(r.weekly_goals).toHaveLength(1);
    expect(r.weekly_goals[0].body).toBe('This week goal');
  });

  it('counts rotting objectives (progress_cache IS NULL)', () => {
    insertObjective(null);   // rotting
    insertObjective(null);   // rotting
    insertObjective(0.4);    // not rotting
    insertObjective(1.0);    // not rotting

    const r = weeklyReview(ANCHOR);
    expect(r.objectives_rotting).toBe(2);
  });

  it('only counts active objectives as rotting', () => {
    insertObjective(null);   // rotting (active by default)
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, progress_cache, created_at, updated_at)
         VALUES (uuid7(), ?, 'Done Obj', 'goal', 'none', 'done', 'none', NULL, ?, ?)`,
      )
      .run(SYSTEM_OWNER, now, now);

    const r = weeklyReview(ANCHOR);
    expect(r.objectives_rotting).toBe(1); // done objective with null progress is NOT rotting
  });

  it('works when anchor is a Monday', () => {
    const r = weeklyReview(MON);
    expect(r.days[0]).toBe(MON);
    expect(r.days[6]).toBe(SUN);
    expect(r.week_key).toBe(WEEK_KEY);
  });

  it('works when anchor is a Sunday', () => {
    const r = weeklyReview(SUN);
    expect(r.days[0]).toBe(MON);
    expect(r.days[6]).toBe(SUN);
    expect(r.week_key).toBe(WEEK_KEY);
  });
});
