import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer, seedFallbackFillWindow } from './helpers.js';
import { clearPlannerRange } from '../src/engine/clear-range.js';
import { placePatternOnDay } from '../src/engine/patterns-place.js';

/**
 * P0 — the shared clear-range engine. Verifies the two suppression shapes
 * (open-ended → UNTIL-cap; bounded → exdates/optouts), the `suppress:'none'`
 * delete-only mode (P1 prune), the `autoOnly` filter, and that templates are
 * never deleted. Dates anchor to *today* (the lazy materializer skips past days)
 * so the suite never time-bombs. Timezone pinned to UTC for determinism.
 */
const OWNER = SYSTEM_OWNER;
const pad = (n: number) => String(n).padStart(2, '0');

const BASE_DAY = new Date();
function isoDay(offset: number): string {
  const d = new Date(BASE_DAY);
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const T0 = isoDay(0), T1 = isoDay(1), T2 = isoDay(2), T3 = isoDay(3), T4 = isoDay(4);
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

const getBlocks = async (from: string, to: string) =>
  (await api(srv.url, `/api/blocks?from=${from}&to=${to}`)).body.blocks as any[];
const instancesOf = async (tplId: string) =>
  (await getBlocks(at(T0, '00:00'), at(T4, '23:59'))).filter((b) => b.recurrence_parent_id === tplId);

async function makeRecurringBlock(rule: string) {
  return (
    await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: {
        title: 'Deep Work', block_kind: 'timeblock', block_type: 'scheduled', tag: 'focus',
        start_at: at(T0, '09:00'), end_at: at(T0, '11:00'), recurrence_rule: rule,
      },
    })
  ).body.block;
}
const ruleOf = (tblId: string) =>
  (sqlite.prepare(`SELECT recurrence_rule FROM time_blocks WHERE id = ?`).get(tblId) as { recurrence_rule: string }).recurrence_rule;
const exdatesOf = (tblId: string) =>
  JSON.parse(
    (sqlite.prepare(`SELECT recurrence_exdates FROM time_blocks WHERE id = ?`).get(tblId) as { recurrence_exdates: string | null })
      .recurrence_exdates ?? '[]',
  ) as string[];

// pattern helpers (mirror pattern-recurrence.test.ts)
const typeId = (name: string) =>
  (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = ? AND owner_id = ?`).get(name, OWNER) as { id: string }).id;
function insertTask(title: string, est = 30): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
      .get(title, OWNER, est) as { id: string }
  ).id;
}
function insertPattern(typeName: string, name: string, taskIds: string[], rule: string, dtstart: string): string {
  const pid = (
    sqlite
      .prepare(`INSERT INTO patterns (id, owner_id, type_id, name, recurrence_rule, recurrence_dtstart) VALUES (uuid7(), ?, ?, ?, ?, ?) RETURNING id`)
      .get(OWNER, typeId(typeName), name, rule, dtstart) as { id: string }
  ).id;
  taskIds.forEach((tid, i) => sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(pid, tid, i));
  return pid;
}
const noon = (day: string) => `${day}T12:00:00.000Z`; // local noon in UTC tz
const patternBlockCount = (pid: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE source_kind = 'pattern' AND source_ref = ?`).get(pid) as { n: number }).n;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  seedFallbackFillWindow(); // 0156: Auto's fallback fill needs work/community windows
  // resetDb does NOT clear patterns/pattern_tasks/pattern_day_optouts, and the DB is
  // shared across test files — scrub them so a leftover (capped) pattern from a prior
  // test/file can't pollute enumeration here (the shared-DB gotcha).
  sqlite.exec(`DELETE FROM pattern_day_optouts; DELETE FROM pattern_tasks; DELETE FROM patterns; DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', enable_routines = 1 WHERE owner_id = ?`).run(OWNER);
});

describe('clearPlannerRange — recurring block templates', () => {
  it('open-ended: caps the rule with UNTIL, deletes on/after instances, keeps earlier + never regenerates', async () => {
    const tpl = await makeRecurringBlock('FREQ=DAILY');
    expect(await instancesOf(tpl.id)).toHaveLength(5); // T0..T4

    const res = await clearPlannerRange({ owner: OWNER, start: T2, suppress: 'auto', dryRun: false });
    expect(res.mode).toBe('open-ended');
    expect(res.blocksDeleted).toBe(3); // T2, T3, T4
    expect(res.generators).toEqual([
      expect.objectContaining({ kind: 'block', id: tpl.id, action: 'until-cap' }),
    ]);

    expect(ruleOf(tpl.id)).toContain('UNTIL='); // template kept, rule capped
    expect(sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(tpl.id)).toBeTruthy(); // template NOT deleted

    // Re-read materializes: T0/T1 survive, T2+ never come back.
    expect((await instancesOf(tpl.id)).map((b) => b.occurrence_date).sort()).toEqual([T0, T1]);
  });

  it('bounded: adds per-day exdates, deletes only the window, leaves the rule uncapped, series resumes', async () => {
    const tpl = await makeRecurringBlock('FREQ=DAILY');
    expect(await instancesOf(tpl.id)).toHaveLength(5);

    const res = await clearPlannerRange({ owner: OWNER, start: T1, end: T2, suppress: 'auto', dryRun: false });
    expect(res.mode).toBe('bounded');
    expect(res.blocksDeleted).toBe(2); // T1, T2 only
    expect(res.generators[0]).toMatchObject({ kind: 'block', action: 'exdates', daysSuppressed: 2 });

    expect(exdatesOf(tpl.id).sort()).toEqual([T1, T2]);
    expect(ruleOf(tpl.id)).toBe('FREQ=DAILY'); // NOT capped

    // Re-read: window stays gone, series resumes after `end`.
    expect((await instancesOf(tpl.id)).map((b) => b.occurrence_date).sort()).toEqual([T0, T3, T4]);
  });

  it("suppress:'none' deletes instances but touches no rule/exdate — reversible (they re-materialize)", async () => {
    const tpl = await makeRecurringBlock('FREQ=DAILY');
    await instancesOf(tpl.id);

    const res = await clearPlannerRange({ owner: OWNER, start: T2, suppress: 'none', dryRun: false });
    expect(res.blocksDeleted).toBe(3);
    expect(res.generators).toHaveLength(0); // nothing suppressed
    expect(ruleOf(tpl.id)).toBe('FREQ=DAILY');
    expect(exdatesOf(tpl.id)).toEqual([]);

    // Standing clamp is P1's job; with no clamp, a plain re-read brings them all back.
    expect((await instancesOf(tpl.id)).map((b) => b.occurrence_date).sort()).toEqual([T0, T1, T2, T3, T4]);
  });

  it('dryRun writes nothing but reports the same counts as the apply', async () => {
    const tpl = await makeRecurringBlock('FREQ=DAILY');
    await instancesOf(tpl.id);
    const before = (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks`).get() as { n: number }).n;

    const dry = await clearPlannerRange({ owner: OWNER, start: T1, suppress: 'auto', dryRun: true });
    expect(dry.blocksDeleted).toBe(4); // T1..T4
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks`).get() as { n: number }).n).toBe(before); // unchanged
    expect(ruleOf(tpl.id)).toBe('FREQ=DAILY'); // not capped

    const wet = await clearPlannerRange({ owner: OWNER, start: T1, suppress: 'auto', dryRun: false });
    expect(wet.blocksDeleted).toBe(dry.blocksDeleted);
  });
});

describe('clearPlannerRange — autoOnly filter', () => {
  it('autoOnly:true deletes engine-generated instances but spares locked + manual blocks', async () => {
    const tpl = await makeRecurringBlock('FREQ=DAILY');
    await instancesOf(tpl.id); // materialize (instances are is_auto=0, recurrence_parent_id set)
    // user-placed manual block + a locked block, both on T2
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id) VALUES (uuid7(), 'Manual', 'timeblock', ?, ?, 0, 0, 'manual', 'planned', ?)`)
      .run(at(T2, '14:00'), at(T2, '15:00'), OWNER);
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id) VALUES (uuid7(), 'Locked', 'timeblock', ?, ?, 1, 0, 'manual', 'planned', ?)`)
      .run(at(T2, '16:00'), at(T2, '17:00'), OWNER);

    await clearPlannerRange({ owner: OWNER, start: T2, suppress: 'none', autoOnly: true, dryRun: false });

    // Recurring instances on/after T2 gone (they have recurrence_parent_id despite is_auto=0).
    // Query the DB directly — a GET would re-materialize them (suppress:'none' leaves the rule).
    const remaining = (
      sqlite.prepare(`SELECT occurrence_date FROM time_blocks WHERE recurrence_parent_id = ? ORDER BY occurrence_date`).all(tpl.id) as { occurrence_date: string }[]
    ).map((r) => r.occurrence_date);
    expect(remaining).toEqual([T0, T1]);
    // Manual + locked survive.
    const titles = (sqlite.prepare(`SELECT title FROM time_blocks WHERE title IN ('Manual','Locked')`).all() as { title: string }[]).map((r) => r.title).sort();
    expect(titles).toEqual(['Locked', 'Manual']);
  });

  it('autoOnly:false (default) removes locked + manual blocks too', async () => {
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id) VALUES (uuid7(), 'Manual', 'timeblock', ?, ?, 0, 0, 'manual', 'planned', ?)`)
      .run(at(T2, '14:00'), at(T2, '15:00'), OWNER);
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id) VALUES (uuid7(), 'Locked', 'timeblock', ?, ?, 1, 0, 'manual', 'planned', ?)`)
      .run(at(T2, '16:00'), at(T2, '17:00'), OWNER);

    const res = await clearPlannerRange({ owner: OWNER, start: T2, suppress: 'none', autoOnly: false, dryRun: false });
    expect(res.blocksDeleted).toBe(2);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE title IN ('Manual','Locked')`).get() as { n: number }).n).toBe(0);
  });
});

describe('clearPlannerRange — daily_plan', () => {
  it('deletes owner-scoped daily_plan rows in range (bounded upper-inclusive)', async () => {
    const task = insertTask('planned');
    const ins = (date: string) => sqlite.prepare(`INSERT INTO daily_plan (owner_id, date, task_id, position) VALUES (?, ?, ?, 0)`).run(OWNER, date, task);
    [T0, T1, T2, T3].forEach(ins);
    const res = await clearPlannerRange({ owner: OWNER, start: T1, end: T2, suppress: 'none', dryRun: false });
    expect(res.dailyPlanDeleted).toBe(2);
    expect((sqlite.prepare(`SELECT date FROM daily_plan ORDER BY date`).all() as { date: string }[]).map((r) => r.date)).toEqual([T0, T3]);
  });
});

describe('clearPlannerRange — recurring patterns', () => {
  it('open-ended: caps the pattern rule and deletes its placed blocks on/after start', async () => {
    const t = insertTask('RoutineTask', 30);
    const pid = insertPattern('Routine', 'DailyRoutine', [t], 'FREQ=DAILY', noon(T0));
    await getBlocks(at(T0, '00:00'), at(T3, '23:59')); // lazy-place T0..T3
    expect(patternBlockCount(pid)).toBeGreaterThanOrEqual(4);

    const res = await clearPlannerRange({ owner: OWNER, start: T2, suppress: 'auto', dryRun: false });
    expect(res.generators.some((g) => g.kind === 'pattern' && g.action === 'until-cap')).toBe(true);
    expect((sqlite.prepare(`SELECT recurrence_rule FROM patterns WHERE id = ?`).get(pid) as { recurrence_rule: string }).recurrence_rule).toContain('UNTIL=');

    // Re-read does not re-place T2/T3 (rule capped); only T0/T1 placements remain.
    await getBlocks(at(T0, '00:00'), at(T3, '23:59'));
    const days = (sqlite.prepare(`SELECT DISTINCT substr(start_at,1,10) AS d FROM time_blocks WHERE source_kind='pattern' AND source_ref=? ORDER BY d`).all(pid) as { d: string }[]).map((r) => r.d);
    expect(days).toEqual([T0, T1]);
  });

  it('open-ended: caps EVERY recurring member-task rule of a multi-member Habit, so the clear sticks', async () => {
    // Regression (adversarial review): the UNION emits one row per recurring member
    // task. Deduping by pattern id would cap only the first member's rule; the second
    // keeps firing and re-places the pattern past the cutoff.
    const mkHabitTask = (title: string) =>
      (sqlite
        .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority, recurrence_rule, recurrence_dtstart) VALUES (uuid7(), ?, ?, 'open', 30, 3, 'FREQ=DAILY', ?) RETURNING id`)
        .get(title, OWNER, noon(T0)) as { id: string }).id;
    const t1 = mkHabitTask('H1');
    const t2 = mkHabitTask('H2');
    const pid = (sqlite.prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, 'MultiHabit') RETURNING id`).get(OWNER, typeId('Habit')) as { id: string }).id;
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`).run(pid, t1);
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 1)`).run(pid, t2);

    await clearPlannerRange({ owner: OWNER, start: T2, suppress: 'auto', dryRun: false });

    const rule = (id: string) => (sqlite.prepare(`SELECT recurrence_rule FROM tasks WHERE id = ?`).get(id) as { recurrence_rule: string }).recurrence_rule;
    expect(rule(t1)).toContain('UNTIL='); // both member rules capped, not just the first
    expect(rule(t2)).toContain('UNTIL=');
  });

  it('bounded: records pattern_day_optouts for the window; a suppressed day is skipped by placePatternOnDay', async () => {
    const t = insertTask('RoutineTask', 30);
    const pid = insertPattern('Routine', 'DailyRoutine', [t], 'FREQ=DAILY', noon(T0));
    await getBlocks(at(T0, '00:00'), at(T3, '23:59'));

    const res = await clearPlannerRange({ owner: OWNER, start: T1, end: T2, suppress: 'auto', dryRun: false });
    const patGen = res.generators.find((g) => g.kind === 'pattern')!;
    expect(patGen).toMatchObject({ action: 'optouts', daysSuppressed: 2 });
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM pattern_day_optouts WHERE pattern_id = ?`).get(pid) as { n: number }).n).toBe(2);
    expect((sqlite.prepare(`SELECT recurrence_rule FROM patterns WHERE id = ?`).get(pid) as { recurrence_rule: string }).recurrence_rule).toBe('FREQ=DAILY'); // NOT capped

    // The opted-out day is honored by the placer directly.
    const placed = await placePatternOnDay(OWNER, pid, { date: T1 });
    expect(placed.skippedAlreadyPlaced).toBe(true);
  });
});
