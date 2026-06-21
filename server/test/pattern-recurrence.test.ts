import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { patternsRecurringOnDate, ensurePatternsForRange } from '../src/engine/patterns-place.js';

/**
 * Pattern-level recurrence + the nightly auto-place job (PR-C+, Phase D).
 * Habits + Routines can carry an RRULE; the 06:00 cron expands matches and
 * runs placePatternOnDay per. Rituals are excluded.
 */

const OWNER = 1;

function typeId(name: string): number {
  return (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = ? AND owner_id = ?`).get(name, OWNER) as { id: number }).id;
}
function insertTask(title: string, est = 30): number {
  return (sqlite
    .prepare(`INSERT INTO tasks (title, owner_id, status, estimated_minutes, priority) VALUES (?, ?, 'open', ?, 3) RETURNING id`)
    .get(title, OWNER, est) as { id: number }).id;
}
function insertPattern(typeName: string, name: string, taskIds: number[], rule?: string, dtstart?: string): number {
  const pid = (sqlite
    .prepare(`INSERT INTO patterns (owner_id, type_id, name, recurrence_rule, recurrence_dtstart) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .get(OWNER, typeId(typeName), name, rule ?? null, dtstart ?? null) as { id: number }).id;
  taskIds.forEach((tid, i) =>
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(pid, tid, i),
  );
  return pid;
}

const MONDAY = '2026-06-22';
const TUESDAY = '2026-06-23';
const noonUTC = (day: string) => `${day}T19:00:00.000Z`; // 12:00 in default LA tz (PDT/-7)

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM pattern_tasks; DELETE FROM patterns WHERE id > 0;`);
  // Default timezone for determinism; recurrence anchors are sensitive to tz.
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'America/Los_Angeles' WHERE owner_id = ?`).run(OWNER);
});

describe('patternsRecurringOnDate', () => {
  it('FREQ=DAILY fires every day', () => {
    insertPattern('Routine', 'Daily', [], 'FREQ=DAILY', noonUTC(MONDAY));
    expect(patternsRecurringOnDate(OWNER, MONDAY).map((p) => p.name)).toEqual(['Daily']);
    expect(patternsRecurringOnDate(OWNER, TUESDAY).map((p) => p.name)).toEqual(['Daily']);
  });

  it('FREQ=WEEKLY;BYDAY=MO fires only on Monday', () => {
    insertPattern('Routine', 'Monday-only', [], 'FREQ=WEEKLY;BYDAY=MO', noonUTC(MONDAY));
    expect(patternsRecurringOnDate(OWNER, MONDAY).map((p) => p.name)).toEqual(['Monday-only']);
    expect(patternsRecurringOnDate(OWNER, TUESDAY).map((p) => p.name)).toEqual([]);
  });

  it('excludes patterns with no rule + excludes Rituals', () => {
    insertPattern('Routine', 'NoRule', [], null as unknown as undefined, undefined);
    insertPattern('Ritual', 'RitualDaily', [], 'FREQ=DAILY', noonUTC(MONDAY));
    insertPattern('Habit', 'HabitDaily', [], 'FREQ=DAILY', noonUTC(MONDAY));
    expect(patternsRecurringOnDate(OWNER, MONDAY).map((p) => p.name).sort()).toEqual(['HabitDaily']);
  });
});

describe('ensurePatternsForRange (lazy placement on GET)', () => {
  it('places every Habit/Routine firing inside the range; Rituals stay excluded', () => {
    const t1 = insertTask('A', 30);
    const t2 = insertTask('B', 30);
    insertPattern('Routine', 'DailyTwo', [t1, t2], 'FREQ=DAILY', noonUTC(MONDAY));
    insertPattern('Habit', 'HabitDaily', [t1], 'FREQ=DAILY', noonUTC(MONDAY));
    insertPattern('Ritual', 'Skipped', [t1], 'FREQ=DAILY', noonUTC(MONDAY));

    const r = ensurePatternsForRange(OWNER, `${MONDAY}T00:00:00.000Z`, `${MONDAY}T23:59:59.999Z`);
    expect(r.placed).toBeGreaterThanOrEqual(1);
    expect(r.blocksCreated).toBeGreaterThanOrEqual(3); // 2 Routine + 1 Habit
    // marker-based idempotency: a 2nd call places nothing new.
    expect(ensurePatternsForRange(OWNER, `${MONDAY}T00:00:00.000Z`, `${MONDAY}T23:59:59.999Z`).blocksCreated).toBe(0);
    // Ritual was not placed.
    const ritualBlocks = sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE source_kind = 'pattern'`).get() as { n: number };
    expect(ritualBlocks.n).toBeGreaterThanOrEqual(3); // routine 2 + habit 1 placed; ritual not.
  });

  it('GET /api/blocks lazy-places recurring patterns inside the requested window', async () => {
    const t = insertTask('A', 30);
    insertPattern('Routine', 'DailyOne', [t], 'FREQ=DAILY', noonUTC(MONDAY));
    // Before the GET, no pattern blocks exist.
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE source_kind = 'pattern'`).get() as { n: number }).n).toBe(0);
    // The GET for Monday triggers lazy placement and returns the placed blocks.
    const r = await api(srv.url, `/api/blocks?from=${MONDAY}T00:00:00.000Z&to=${MONDAY}T23:59:59.999Z`);
    expect(r.status).toBe(200);
    expect(r.body.blocks.some((b: any) => b.source_kind === 'pattern' && b.title === 'A')).toBe(true);
  });

  it('does NOT backfill past days (no recursion into yesterday on a normal read)', () => {
    const yesterday = '2026-06-15';
    const t = insertTask('A', 30);
    insertPattern('Routine', 'DailyOne', [t], 'FREQ=DAILY', noonUTC(yesterday));
    ensurePatternsForRange(OWNER, `${yesterday}T00:00:00.000Z`, `${yesterday}T23:59:59.999Z`);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE source_kind = 'pattern'`).get() as { n: number }).n).toBe(0);
  });

  it('the place_patterns cron is GONE (no scheduled_jobs row)', () => {
    const row = sqlite.prepare(`SELECT 1 FROM scheduled_jobs WHERE kind = 'place_patterns'`).get();
    expect(row).toBeUndefined();
  });
});

describe('PATCH /api/patterns/:id recurrence validation', () => {
  it('200 on FREQ=DAILY for a Routine; defaults recurrence_dtstart to local-noon-as-UTC', async () => {
    const pid = insertPattern('Routine', 'R', []);
    const r = await api(srv.url, `/api/patterns/${pid}`, { method: 'PATCH', json: { recurrence_rule: 'FREQ=DAILY' } });
    expect(r.status).toBe(200);
    expect(r.body.pattern.recurrence_rule).toBe('FREQ=DAILY');
    expect(r.body.pattern.recurrence_dtstart).toBeTruthy(); // server picked the local-noon default
  });

  it('422 for FREQ=HOURLY (parseRule rejects sub-daily)', async () => {
    const pid = insertPattern('Routine', 'R', []);
    const r = await api(srv.url, `/api/patterns/${pid}`, { method: 'PATCH', json: { recurrence_rule: 'FREQ=HOURLY' } });
    expect(r.status).toBe(422);
  });

  it('422 for setting a rule on a Ritual pattern', async () => {
    const pid = insertPattern('Ritual', 'R', []);
    const r = await api(srv.url, `/api/patterns/${pid}`, { method: 'PATCH', json: { recurrence_rule: 'FREQ=DAILY' } });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Habit and Routine/i);
  });

  it('null clears the rule', async () => {
    const pid = insertPattern('Routine', 'R', [], 'FREQ=DAILY', noonUTC(MONDAY));
    const r = await api(srv.url, `/api/patterns/${pid}`, { method: 'PATCH', json: { recurrence_rule: null } });
    expect(r.status).toBe(200);
    expect(r.body.pattern.recurrence_rule).toBeNull();
  });
});
