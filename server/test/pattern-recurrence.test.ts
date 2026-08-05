import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { patternsRecurringOnDate, ensurePatternsForRange } from '../src/engine/patterns-place.js';
import { localISODate } from '../src/lib/dates.js';

/**
 * Pattern-level recurrence + the nightly auto-place job (PR-C+, Phase D).
 * Habits + Routines can carry an RRULE; the 06:00 cron expands matches and
 * runs placePatternOnDay per. Rituals are excluded.
 */

const OWNER = SYSTEM_OWNER;

function typeId(name: string): string {
  return (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = ? AND owner_id = ?`).get(name, OWNER) as { id: string }).id;
}
function insertTask(title: string, est = 30): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
    .get(title, OWNER, est) as { id: string }).id;
}
function insertPattern(typeName: string, name: string, taskIds: string[], rule?: string, dtstart?: string): string {
  const pid = (sqlite
    .prepare(`INSERT INTO patterns (id, owner_id, type_id, name, recurrence_rule, recurrence_dtstart) VALUES (uuid7(), ?, ?, ?, ?, ?) RETURNING id`)
    .get(OWNER, typeId(typeName), name, rule ?? null, dtstart ?? null) as { id: string }).id;
  taskIds.forEach((tid, i) =>
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(pid, tid, i),
  );
  return pid;
}

const MONDAY = '2026-06-22';
const TUESDAY = '2026-06-23';
const noonUTC = (day: string) => `${day}T19:00:00.000Z`; // 12:00 in default LA tz (PDT/-7)
// Lazy placement (ensurePatternsForRange) skips any day before the server-local "today"
// (its own `d >= localISODate()` filter), so placement fixtures must target a current
// day — a hardcoded date silently becomes a no-op once the wall clock passes it. TODAY
// mirrors the engine's comparison basis so these tests are stable on any run date / TZ.
const TODAY = localISODate();

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM pattern_tasks; DELETE FROM patterns WHERE id > 0;`);
  // Default timezone for determinism; recurrence anchors are sensitive to tz.
  // enable_routines is OFF by default (0073), which gates recurring Routine
  // auto-placement; turn it ON here so the placement tests below exercise both
  // Routine + Habit. The dedicated gate test flips it back to 0 explicitly.
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'America/Los_Angeles', enable_routines = 1 WHERE owner_id = ?`).run(OWNER);
});

describe('patternsRecurringOnDate', () => {
  it('FREQ=DAILY fires every day', async () => {
    insertPattern('Routine', 'Daily', [], 'FREQ=DAILY', noonUTC(MONDAY));
    expect((await patternsRecurringOnDate(OWNER, MONDAY)).map((p) => p.name)).toEqual(['Daily']);
    expect((await patternsRecurringOnDate(OWNER, TUESDAY)).map((p) => p.name)).toEqual(['Daily']);
  });

  it('FREQ=WEEKLY;BYDAY=MO fires only on Monday', async () => {
    insertPattern('Routine', 'Monday-only', [], 'FREQ=WEEKLY;BYDAY=MO', noonUTC(MONDAY));
    expect((await patternsRecurringOnDate(OWNER, MONDAY)).map((p) => p.name)).toEqual(['Monday-only']);
    expect((await patternsRecurringOnDate(OWNER, TUESDAY)).map((p) => p.name)).toEqual([]);
  });

  it('excludes patterns with no rule + excludes Rituals', async () => {
    insertPattern('Routine', 'NoRule', [], null as unknown as undefined, undefined);
    insertPattern('Ritual', 'RitualDaily', [], 'FREQ=DAILY', noonUTC(MONDAY));
    insertPattern('Habit', 'HabitDaily', [], 'FREQ=DAILY', noonUTC(MONDAY));
    expect((await patternsRecurringOnDate(OWNER, MONDAY)).map((p) => p.name).sort()).toEqual(['HabitDaily']);
  });
});

describe('await ensurePatternsForRange (lazy placement on GET)', () => {
  it('places every Habit/Routine firing inside the range; Rituals stay excluded', async () => {
    const t1 = insertTask('A', 30);
    const t2 = insertTask('B', 30);
    insertPattern('Routine', 'DailyTwo', [t1, t2], 'FREQ=DAILY', noonUTC(TODAY));
    insertPattern('Habit', 'HabitDaily', [t1], 'FREQ=DAILY', noonUTC(TODAY));
    insertPattern('Ritual', 'Skipped', [t1], 'FREQ=DAILY', noonUTC(TODAY));

    const r = await ensurePatternsForRange(OWNER, `${TODAY}T00:00:00.000Z`, `${TODAY}T23:59:59.999Z`);
    expect(r.placed).toBeGreaterThanOrEqual(1);
    expect(r.blocksCreated).toBeGreaterThanOrEqual(3); // 2 Routine + 1 Habit
    // marker-based idempotency: a 2nd call places nothing new.
    expect((await ensurePatternsForRange(OWNER, `${TODAY}T00:00:00.000Z`, `${TODAY}T23:59:59.999Z`)).blocksCreated).toBe(0);
    // Ritual was not placed.
    const ritualBlocks = sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE source_kind = 'pattern'`).get() as { n: number };
    expect(ritualBlocks.n).toBeGreaterThanOrEqual(3); // routine 2 + habit 1 placed; ritual not.
  });

  it('GET /api/blocks lazy-places recurring patterns inside the requested window', async () => {
    const t = insertTask('A', 30);
    insertPattern('Routine', 'DailyOne', [t], 'FREQ=DAILY', noonUTC(TODAY));
    // Before the GET, no pattern blocks exist.
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE source_kind = 'pattern'`).get() as { n: number }).n).toBe(0);
    // The GET for today triggers lazy placement and returns the placed blocks.
    const r = await api(srv.url, `/api/blocks?from=${TODAY}T00:00:00.000Z&to=${TODAY}T23:59:59.999Z`);
    expect(r.status).toBe(200);
    expect(r.body.blocks.some((b: any) => b.source_kind === 'pattern' && b.title === 'A')).toBe(true);
  });

  it('skips recurring Routines when enable_routines is OFF, but still places Habits', async () => {
    // Regression: with the flag off, a deleted Routine container used to regenerate
    // on the very next read (the refetch after delete), so it could never be removed.
    sqlite.prepare(`UPDATE scheduling_prefs SET enable_routines = 0 WHERE owner_id = ?`).run(OWNER);
    insertPattern('Routine', 'DailyRoutine', [insertTask('RoutineTaskA', 30), insertTask('RoutineTaskB', 30)], 'FREQ=DAILY', noonUTC(TODAY));
    insertPattern('Habit', 'DailyHabit', [insertTask('HabitTask', 30)], 'FREQ=DAILY', noonUTC(TODAY));

    await ensurePatternsForRange(OWNER, `${TODAY}T00:00:00.000Z`, `${TODAY}T23:59:59.999Z`);

    // Only the Habit placed (its container + task block); the Routine's container
    // and both its task blocks are absent — nothing for the user to fight to delete.
    const titles = (sqlite
      .prepare(`SELECT title FROM time_blocks WHERE source_kind = 'pattern' ORDER BY title`)
      .all() as { title: string }[]).map((r) => r.title);
    expect(titles).toEqual(['DailyHabit', 'HabitTask']);
  });

  it('honours a pattern_day_optout: an opted-out (pattern, day) is not placed', async () => {
    const t = insertTask('A', 30);
    const pid = insertPattern('Routine', 'DailyOne', [t], 'FREQ=DAILY', noonUTC(TODAY));
    sqlite.prepare(`INSERT INTO pattern_day_optouts (owner_id, pattern_id, date) VALUES (?, ?, ?)`).run(OWNER, pid, TODAY);

    await ensurePatternsForRange(OWNER, `${TODAY}T00:00:00.000Z`, `${TODAY}T23:59:59.999Z`);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE source_kind = 'pattern'`).get() as { n: number }).n).toBe(0);
  });

  it('a deleted recurring-pattern container stays deleted (DELETE records the opt-out; no regen on next read)', async () => {
    // The exact user scenario: a recurring pattern places a container, the user
    // deletes it, and the immediate refetch used to regenerate it.
    const t = insertTask('Task A', 30);
    const pid = insertPattern('Routine', 'DailyRoutine', [t], 'FREQ=DAILY', noonUTC(TODAY));
    const range = `?from=${TODAY}T00:00:00.000Z&to=${TODAY}T23:59:59.999Z`;

    // First read lazily places the container.
    let blocks = (await api(srv.url, `/api/blocks${range}`)).body.blocks;
    const container = blocks.find((b: any) => b.block_kind === 'timeblock' && b.source_kind === 'pattern' && b.title === 'DailyRoutine');
    expect(container).toBeTruthy();

    // Delete it (cascading its task children).
    expect((await api(srv.url, `/api/blocks/${container.id}?children=delete`, { method: 'DELETE' })).status).toBe(200);
    // The opt-out row was recorded for this pattern …
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM pattern_day_optouts WHERE pattern_id = ?`).get(pid) as { n: number }).n).toBe(1);

    // … so the next read does NOT bring the container back.
    blocks = (await api(srv.url, `/api/blocks${range}`)).body.blocks;
    expect(blocks.some((b: any) => b.source_kind === 'pattern' && b.title === 'DailyRoutine')).toBe(false);
  });

  it('does NOT backfill past days (no recursion into yesterday on a normal read)', async () => {
    const yesterday = '2026-06-15';
    const t = insertTask('A', 30);
    insertPattern('Routine', 'DailyOne', [t], 'FREQ=DAILY', noonUTC(yesterday));
    await ensurePatternsForRange(OWNER, `${yesterday}T00:00:00.000Z`, `${yesterday}T23:59:59.999Z`);
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
