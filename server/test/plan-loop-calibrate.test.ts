import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { calibratePlanLoop, STATS_WINDOW_DAYS } from '../src/services/plan-loop-learning.js';
import { runJob } from '../src/jobs/index.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

/**
 * Ticket 3 — the weekly deterministic BATCH pass over `plan_loop_runs`.
 *
 * Fixture style matches classification-learning/triality-learning's: raw sqlite
 * inserts against the shared sequential DB, a frozen `NOW`, every `at` an explicit
 * ISO string derived from it (never `Date.now()` — the uuid7-tie-ordering note: a
 * loop-built fixture with identical timestamps gets a random read order).
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-08-14T12:00:00.000Z');

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

/** Seed one `plan_loop_runs` row directly. Each call gets a fresh id. */
function seedRun(opts: {
  owner?: string;
  stage?: string;
  passed: 0 | 1;
  escaped?: 0 | 1;
  escapeReason?: string | null;
  iterations: number;
  at: string;
  score?: number;
}): void {
  sqlite
    .prepare(
      `INSERT INTO plan_loop_runs (id, owner_id, stage, passed, escaped, escape_reason, score, iterations, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      opts.owner ?? OWNER,
      opts.stage ?? 'order',
      opts.passed,
      opts.escaped ?? 0,
      opts.escapeReason ?? null,
      opts.score ?? (opts.passed ? 0.8 : -1),
      opts.iterations,
      opts.at,
    );
}

/** Seed one `plan_revision_log` row directly. `defects` is the JSON text as stored. */
function seedRevision(opts: { owner?: string; stage?: string; defects: string[] | string; at: string; runId?: string }): void {
  sqlite
    .prepare(
      `INSERT INTO plan_revision_log (id, owner_id, run_id, stage, iter, score, reason, defects, critique, candidate, at)
       VALUES (?, ?, ?, ?, 1, 0.5, 'judged', ?, '', NULL, ?)`,
    )
    .run(
      newId(),
      opts.owner ?? OWNER,
      opts.runId ?? 'run-1',
      opts.stage ?? 'order',
      typeof opts.defects === 'string' ? opts.defects : JSON.stringify(opts.defects),
      opts.at,
    );
}

function statsFor(owner: string): {
  stage: string;
  computed_date: string;
  period_days: number;
  runs: number;
  passed: number;
  escaped: number;
  first_try_pass: number;
  avg_iterations: number | null;
  pass_rate: number | null;
}[] {
  return sqlite
    .prepare(`SELECT * FROM plan_loop_stats WHERE owner_id = ? ORDER BY stage`)
    .all(owner) as ReturnType<typeof statsFor>;
}

describe('calibratePlanLoop', () => {
  beforeEach(() => resetDb());

  it('aggregates one stage: runs, passed, escaped, first-try pass, pass rate, avg iterations', async () => {
    // 4 passed (3 of them first-try), 1 escaped.
    seedRun({ passed: 1, iterations: 1, at: hoursAgo(1) });
    seedRun({ passed: 1, iterations: 1, at: hoursAgo(2) });
    seedRun({ passed: 1, iterations: 1, at: hoursAgo(3) });
    seedRun({ passed: 1, iterations: 3, at: hoursAgo(4) }); // passed, but not first-try
    seedRun({ passed: 0, escaped: 1, escapeReason: 'max-iterations', iterations: 5, at: hoursAgo(5) });

    const r = await calibratePlanLoop(OWNER, NOW);

    expect(r.stages).toHaveLength(1);
    const order = r.stages[0];
    expect(order.stage).toBe('order');
    expect(order.runs).toBe(5);
    expect(order.passed).toBe(4);
    expect(order.escaped).toBe(1);
    expect(order.firstTryPass).toBe(3);
    expect(order.passRate).toBeCloseTo(0.8);
    expect(order.avgIterations).toBeCloseTo((1 + 1 + 1 + 3 + 5) / 5); // 2.2

    const rows = statsFor(OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage: 'order',
      period_days: STATS_WINDOW_DAYS,
      runs: 5,
      passed: 4,
      escaped: 1,
      first_try_pass: 3,
    });
    expect(rows[0].pass_rate).toBeCloseTo(0.8);
    expect(rows[0].avg_iterations).toBeCloseTo(2.2);
  });

  it('excludes a run dated 8 days ago and includes one dated 6 days ago', async () => {
    seedRun({ passed: 1, iterations: 1, at: daysAgo(8) }); // outside the 7-day window
    seedRun({ passed: 1, iterations: 3, at: daysAgo(6) }); // inside

    const r = await calibratePlanLoop(OWNER, NOW);

    expect(r.stages).toHaveLength(1);
    expect(r.stages[0].runs).toBe(1);
    expect(r.stages[0].avgIterations).toBeCloseTo(3);

    const rows = statsFor(OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0].runs).toBe(1);
    expect(rows[0].avg_iterations).toBeCloseTo(3);
  });

  it('re-running on the same day UPSERTs — exactly one row per stage, values replaced', async () => {
    seedRun({ passed: 1, iterations: 1, at: hoursAgo(3) });
    const first = await calibratePlanLoop(OWNER, NOW);
    expect(first.stages[0].runs).toBe(1);

    seedRun({ passed: 0, escaped: 1, escapeReason: 'plateau', iterations: 4, at: hoursAgo(1) });
    const second = await calibratePlanLoop(OWNER, NOW);
    expect(second.stages[0].runs).toBe(2);

    const rows = statsFor(OWNER);
    expect(rows).toHaveLength(1); // still one row, not two
    expect(rows[0].runs).toBe(2);
    expect(rows[0].passed).toBe(1);
    expect(rows[0].escaped).toBe(1);

    const count = (
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM plan_loop_stats WHERE owner_id = ? AND stage = 'order'`)
        .get(OWNER) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('two owners produce independent stats rows; owner A never sees owner B\'s runs', async () => {
    createOwner(); // seeds SECOND_OWNER_ID

    seedRun({ owner: OWNER, passed: 1, iterations: 1, at: hoursAgo(1) });
    seedRun({ owner: OWNER, passed: 1, iterations: 2, at: hoursAgo(2) });
    seedRun({ owner: SECOND_OWNER_ID, passed: 0, escaped: 1, escapeReason: 'budget', iterations: 6, at: hoursAgo(1) });

    const rA = await calibratePlanLoop(OWNER, NOW);
    const rB = await calibratePlanLoop(SECOND_OWNER_ID, NOW);

    expect(rA.stages).toHaveLength(1);
    expect(rA.stages[0].runs).toBe(2);
    expect(rA.stages[0].passed).toBe(2);
    expect(rA.stages[0].escaped).toBe(0);

    expect(rB.stages).toHaveLength(1);
    expect(rB.stages[0].runs).toBe(1);
    expect(rB.stages[0].escaped).toBe(1);

    const statsA = statsFor(OWNER);
    const statsB = statsFor(SECOND_OWNER_ID);
    expect(statsA).toHaveLength(1);
    expect(statsB).toHaveLength(1);
    expect(statsA[0].runs).toBe(2);
    expect(statsB[0].runs).toBe(1);
  });

  it('an owner with zero runs in the window gets zero stats rows', async () => {
    const r = await calibratePlanLoop(OWNER, NOW);
    expect(r.stages).toEqual([]);

    const count = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM plan_loop_stats WHERE owner_id = ?`).get(OWNER) as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it('two distinct stages in the window produce two separate stats rows', async () => {
    seedRun({ stage: 'order', passed: 1, iterations: 1, at: hoursAgo(1) });
    seedRun({ stage: 'draft', passed: 0, escaped: 1, escapeReason: 'plateau', iterations: 4, at: hoursAgo(2) });

    const r = await calibratePlanLoop(OWNER, NOW);
    expect(r.stages.map((s) => s.stage).sort()).toEqual(['draft', 'order']);

    const rows = statsFor(OWNER);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.stage).sort()).toEqual(['draft', 'order']);
  });
});

describe('calibratePlanLoop — the rules the checker flagged most often', () => {
  beforeEach(() => resetDb());

  it('counts each rule once per revision, most first, ties by rule name, at most three', async () => {
    seedRun({ passed: 1, iterations: 1, at: hoursAgo(1) });
    seedRevision({ defects: ['priority_inversion', 'overlap'], at: hoursAgo(1) });
    seedRevision({ defects: ['priority_inversion', 'priority_inversion'], at: hoursAgo(2) }); // twice in one revision: once
    seedRevision({ defects: ['overlap'], at: hoursAgo(3) });
    seedRevision({ defects: ['zeta'], at: hoursAgo(4) });
    seedRevision({ defects: ['alpha'], at: hoursAgo(5) });
    seedRevision({ defects: [], at: hoursAgo(6) });

    const [s] = (await calibratePlanLoop(OWNER, NOW)).stages;
    expect(s.revisions).toBe(6);
    expect(s.topDefects).toEqual([
      { rule: 'overlap', revisions: 2 },
      { rule: 'priority_inversion', revisions: 2 },
      { rule: 'alpha', revisions: 1 }, // 'alpha' beats 'zeta' on the tie, and zeta is cut at three
    ]);
  });

  it('reads only this owner, this stage and the window', async () => {
    createOwner(SECOND_OWNER_ID);
    seedRun({ passed: 1, iterations: 1, at: hoursAgo(1) });
    seedRevision({ defects: ['mine'], at: hoursAgo(1) });
    seedRevision({ defects: ['too_old'], at: daysAgo(STATS_WINDOW_DAYS + 1) });
    seedRevision({ stage: 'other', defects: ['other_stage'], at: hoursAgo(1) });
    seedRevision({ owner: SECOND_OWNER_ID, defects: ['theirs'], at: hoursAgo(1) });

    const [s] = (await calibratePlanLoop(OWNER, NOW)).stages;
    expect(s.revisions).toBe(1);
    expect(s.topDefects).toEqual([{ rule: 'mine', revisions: 1 }]);
  });

  it('survives a defects value that is not a JSON array of strings', async () => {
    seedRun({ passed: 1, iterations: 1, at: hoursAgo(1) });
    seedRevision({ defects: 'not json', at: hoursAgo(1) });
    seedRevision({ defects: '{"a":1}', at: hoursAgo(2) });
    seedRevision({ defects: '[1,null,"","real"]', at: hoursAgo(3) });

    const [s] = (await calibratePlanLoop(OWNER, NOW)).stages;
    expect(s.revisions).toBe(3);
    expect(s.topDefects).toEqual([{ rule: 'real', revisions: 1 }]);
  });

  it('reports an empty list and zero revisions when none were logged', async () => {
    seedRun({ passed: 1, iterations: 1, at: hoursAgo(1) });
    const [s] = (await calibratePlanLoop(OWNER, NOW)).stages;
    expect(s).toMatchObject({ revisions: 0, topDefects: [] });
  });
});

describe('calibrate_plan_loop job', () => {
  beforeEach(() => resetDb());

  // The job calls calibratePlanLoop(currentOwnerId(), new Date()) with the REAL
  // clock, so fixtures here anchor to actual now, not the fixed NOW above.
  const realHoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it('reports itemsUpdated = stats rows written and a log naming each stage', async () => {
    seedRun({ stage: 'order', passed: 1, iterations: 1, at: realHoursAgo(1) });
    seedRun({ stage: 'draft', passed: 0, escaped: 1, escapeReason: 'plateau', iterations: 4, at: realHoursAgo(2) });

    const result = await runJob('calibrate_plan_loop');

    expect(result.status).toBe('done');
    expect(result.itemsUpdated).toBe(2);
    expect(result.log).toContain('order');
    expect(result.log).toContain('draft');

    const rows = statsFor(OWNER);
    expect(rows).toHaveLength(2);
  });

  it('names the most flagged rules in the log, and says so when none were flagged', async () => {
    seedRun({ passed: 1, iterations: 1, at: realHoursAgo(1) });
    seedRevision({ defects: ['priority_inversion'], at: realHoursAgo(1) });
    seedRevision({ defects: ['priority_inversion', 'overlap'], at: realHoursAgo(2) });
    seedRevision({ defects: [], at: realHoursAgo(3) });

    const flagged = await runJob('calibrate_plan_loop');
    expect(flagged.log).toContain('most flagged: priority_inversion (2 of 3 revision(s)), overlap (1 of 3 revision(s))');

    resetDb();
    seedRun({ passed: 1, iterations: 1, at: realHoursAgo(1) });
    const none = await runJob('calibrate_plan_loop');
    expect(none.log).toContain('; no rule flagged');
  });

  it('reports "nothing to measure" and itemsUpdated = 0 when there are no runs', async () => {
    const result = await runJob('calibrate_plan_loop');

    expect(result.status).toBe('done');
    expect(result.itemsUpdated).toBe(0);
    expect(result.log).toContain('nothing to measure');
  });
});
