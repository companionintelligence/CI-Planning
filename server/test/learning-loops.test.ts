import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { calibrateEstimates } from '../src/jobs/calibrate-estimates.js';
import { aggregatePlanOutcomes } from '../src/jobs/aggregate-plan-outcomes.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb } from './helpers.js';

// Pinned date: a Wednesday (so "yesterday" is Tuesday for the outcomes job).
const TODAY = '2026-06-17';
const YESTERDAY = '2026-06-16';

function insertTask(opts: {
  estimatedMinutes: number | null;
  actualMinutes: number;
  status?: string;
  completedAt?: string;
}) {
  return sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, actual_minutes, completed_at)
       VALUES (uuid7(), 'T', ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      SYSTEM_OWNER,
      opts.status ?? 'done',
      opts.estimatedMinutes,
      opts.actualMinutes,
      opts.completedAt ?? null,
    ) as { id: string };
}

function insertBlock(taskId: string, date: string, status = 'done') {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, task_id, status)
       VALUES (uuid7(), 'B', 'task', ?, ?, ?, ?)`,
    )
    .run(`${date}T10:00:00.000Z`, `${date}T11:00:00.000Z`, taskId, status);
}

describe('calibrateEstimates', () => {
  beforeEach(() => {
    resetDb();
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone='UTC' WHERE owner_id=?`).run(SYSTEM_OWNER);
  });

  it('returns zero sample_count when no timed tasks exist', () => {
    const r = calibrateEstimates();
    expect(r.sample_count).toBe(0);
    expect(r.bias_ratio).toBeNull();
  });

  it('ignores tasks missing estimated_minutes', () => {
    insertTask({ estimatedMinutes: null, actualMinutes: 60, status: 'done' });
    const r = calibrateEstimates();
    expect(r.sample_count).toBe(0);
  });

  it('ignores tasks with actual_minutes = 0 (never timed)', () => {
    insertTask({ estimatedMinutes: 30, actualMinutes: 0, status: 'done' });
    const r = calibrateEstimates();
    expect(r.sample_count).toBe(0);
  });

  it('ignores tasks not yet done', () => {
    insertTask({ estimatedMinutes: 30, actualMinutes: 45, status: 'open' });
    const r = calibrateEstimates();
    expect(r.sample_count).toBe(0);
  });

  it('computes bias_ratio = median(actual/estimated) for a single task', () => {
    // actual=60, estimated=40 → ratio=1.5
    insertTask({ estimatedMinutes: 40, actualMinutes: 60, status: 'done' });
    const r = calibrateEstimates();
    expect(r.sample_count).toBe(1);
    expect(r.bias_ratio).toBeCloseTo(1.5, 5);
    expect(r.p50).toBeCloseTo(1.5, 5);
  });

  it('computes correct median and quartiles for multiple tasks', () => {
    // ratios: 0.5, 1.0, 1.5, 2.0, 2.5 → median=1.5, p25=1.0, p75=2.0
    for (const [est, act] of [[20, 10], [30, 30], [40, 60], [20, 40], [20, 50]]) {
      insertTask({ estimatedMinutes: est, actualMinutes: act, status: 'done' });
    }
    const r = calibrateEstimates();
    expect(r.sample_count).toBe(5);
    expect(r.bias_ratio).toBeCloseTo(1.5, 4);
    expect(r.p25).toBeCloseTo(1.0, 4);
    expect(r.p75).toBeCloseTo(2.0, 4);
  });

  it('persists the result to estimate_calibration', () => {
    insertTask({ estimatedMinutes: 30, actualMinutes: 45, status: 'done' });
    calibrateEstimates();
    const row = sqlite
      .prepare(`SELECT * FROM estimate_calibration WHERE owner_id=?`)
      .get(SYSTEM_OWNER) as { sample_count: number; bias_ratio: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.sample_count).toBe(1);
    expect(row!.bias_ratio).toBeCloseTo(1.5, 4);
  });

  it('is idempotent — re-running overwrites the row', () => {
    insertTask({ estimatedMinutes: 30, actualMinutes: 45, status: 'done' });
    calibrateEstimates();
    calibrateEstimates();
    const count = (sqlite.prepare(`SELECT COUNT(*) as n FROM estimate_calibration WHERE owner_id=?`).get(SYSTEM_OWNER) as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('aggregatePlanOutcomes', () => {
  beforeEach(() => {
    resetDb();
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone='UTC' WHERE owner_id=?`).run(SYSTEM_OWNER);
  });

  it('returns planned=0 completed=0 when no blocks exist for the date', () => {
    const r = aggregatePlanOutcomes(YESTERDAY, TODAY);
    expect(r.planned).toBe(0);
    expect(r.completed).toBe(0);
  });

  it('counts task-bearing blocks for the date as planned', () => {
    const { id: t1 } = insertTask({ estimatedMinutes: 30, actualMinutes: 0, status: 'open' });
    const { id: t2 } = insertTask({ estimatedMinutes: 30, actualMinutes: 0, status: 'open' });
    insertBlock(t1, YESTERDAY);
    insertBlock(t2, YESTERDAY);
    // A block for today — should NOT count
    insertBlock(t1, TODAY);

    const r = aggregatePlanOutcomes(YESTERDAY, TODAY);
    expect(r.planned).toBe(2);
  });

  it('counts completed tasks among planned as completed', () => {
    const { id: t1 } = insertTask({
      estimatedMinutes: 30, actualMinutes: 45, status: 'done',
      completedAt: `${YESTERDAY}T15:00:00.000Z`,
    });
    const { id: t2 } = insertTask({
      estimatedMinutes: 30, actualMinutes: 0, status: 'open',
    });
    insertBlock(t1, YESTERDAY);
    insertBlock(t2, YESTERDAY);

    const r = aggregatePlanOutcomes(YESTERDAY, TODAY);
    expect(r.planned).toBe(2);
    expect(r.completed).toBe(1);
  });

  it('does not count meeting blocks as planned tasks', () => {
    const { id: t1 } = insertTask({ estimatedMinutes: 30, actualMinutes: 0, status: 'done' });
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, task_id, status)
         VALUES (uuid7(), 'Standup', 'meeting', ?, ?, ?, 'done')`,
      )
      .run(`${YESTERDAY}T09:00:00.000Z`, `${YESTERDAY}T09:30:00.000Z`, t1);

    const r = aggregatePlanOutcomes(YESTERDAY, TODAY);
    expect(r.planned).toBe(0);
  });

  it('does not count blocks with no task_id as planned tasks', () => {
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, status)
         VALUES (uuid7(), 'Event', 'task', ?, ?, 'done')`,
      )
      .run(`${YESTERDAY}T10:00:00.000Z`, `${YESTERDAY}T11:00:00.000Z`);

    const r = aggregatePlanOutcomes(YESTERDAY, TODAY);
    expect(r.planned).toBe(0);
  });

  it('persists the result to plan_outcomes', () => {
    const { id: t1 } = insertTask({
      estimatedMinutes: 30, actualMinutes: 45, status: 'done',
      completedAt: `${YESTERDAY}T15:00:00.000Z`,
    });
    insertBlock(t1, YESTERDAY);
    aggregatePlanOutcomes(YESTERDAY, TODAY);

    const row = sqlite
      .prepare(`SELECT * FROM plan_outcomes WHERE owner_id=? AND date=?`)
      .get(SYSTEM_OWNER, YESTERDAY) as { planned: number; completed: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.planned).toBe(1);
    expect(row!.completed).toBe(1);
  });

  it('is idempotent — re-running overwrites the row', () => {
    const { id: t1 } = insertTask({ estimatedMinutes: 30, actualMinutes: 0, status: 'open' });
    insertBlock(t1, YESTERDAY);
    aggregatePlanOutcomes(YESTERDAY, TODAY);
    aggregatePlanOutcomes(YESTERDAY, TODAY);

    const count = (
      sqlite
        .prepare(`SELECT COUNT(*) as n FROM plan_outcomes WHERE owner_id=? AND date=?`)
        .get(SYSTEM_OWNER, YESTERDAY) as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});
