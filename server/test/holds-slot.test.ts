import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';
import { extendBlock } from '../src/engine/extend-block.js';

/**
 * "L02 Time Blocks hold their slot" (the mobility ladder, plan decision 2) — asserted
 * against the obstacle queries that have to make it true.
 *
 * Both of them used to test `block_type = 'scheduled'`, a value ONLY the Element wizard
 * writes. Every other creation path leaves it NULL, so a Time Block drawn in the Planner
 * held no slot and the engine placed a task straight through it.
 *
 * The geometry is the whole fixture: the container sits at the START of the direction
 * window, exactly where the packer would otherwise put the task. A container parked
 * anywhere else would be avoided by luck rather than by the rule, and every one of these
 * tests would pass with the bug still in.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22'; // a Monday → day type 'workday'
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16);

function directionTagId(name: string): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction'`)
    .get(OWNER, name) as { id: string } | undefined;
  if (found) return found.id;
  return (sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, 'direction') RETURNING id`)
    .get(name, OWNER) as { id: string }).id;
}

function seedWindow(direction: string, start: string, end: string): void {
  sqlite.prepare(
    `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
     VALUES (uuid7(), ?, ?, 'workday', ?, ?)`,
  ).run(OWNER, directionTagId(direction), start, end);
}

/** A Time Block. `blockType` defaults to NULL — the shape every non-wizard path writes. */
function container(opts: {
  start: string; end: string;
  blockType?: string | null;
  tag?: string | null;
  allDay?: boolean;
  recurrenceRule?: string | null;
  recurrenceParentId?: string | null;
  title?: string;
}): string {
  return (sqlite.prepare(
    `INSERT INTO time_blocks (id, owner_id, title, block_kind, block_type, tag, start_at, end_at,
                              is_auto, is_locked, source_kind, status, all_day, recurrence_rule, recurrence_parent_id)
     VALUES (uuid7(), ?, ?, 'timeblock', ?, ?, ?, ?, 0, 0, 'manual', 'planned', ?, ?, ?) RETURNING id`,
  ).get(
    OWNER, opts.title ?? 'Deep work', opts.blockType ?? null,
    opts.tag === undefined ? 'work' : opts.tag, at(opts.start), at(opts.end),
    opts.allDay ? 1 : 0, opts.recurrenceRule ?? null, opts.recurrenceParentId ?? null,
  ) as { id: string }).id;
}

/** A staged, open, work-tagged task. */
function stageTask(title: string, est = 60): string {
  const id = (sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority)
     VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`,
  ).get(title, OWNER, est) as { id: string }).id;
  sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`)
    .run(id, directionTagId('work'));
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`)
    .run(OWNER, id);
  return id;
}

function placementOf(title: string): { start: string; end: string; parent: string | null } | undefined {
  const row = sqlite.prepare(
    `SELECT b.start_at, b.end_at, b.parent_block_id FROM time_blocks b JOIN tasks t ON t.id = b.task_id
      WHERE t.title = ? AND b.block_kind = 'task' ORDER BY b.start_at LIMIT 1`,
  ).get(title) as { start_at: string; end_at: string; parent_block_id: string | null } | undefined;
  return row && { start: hhmm(row.start_at), end: hhmm(row.end_at), parent: row.parent_block_id };
}

/** Does the placement overlap [10:00-shaped] `start`–`end`? */
const overlaps = (p: { start: string; end: string }, start: string, end: string) =>
  p.start < end && p.end > start;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM flight_plan; DELETE FROM pattern_blocks;');
  sqlite.prepare(
    `UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '12:00',
            auto_fill_workday = 0 WHERE owner_id = ?`,
  ).run(OWNER);
  // The work window opens at 09:00 — the same minute the containers below start.
  seedWindow('work', '09:00', '12:00');
});

describe('a Time Block holds its slot against the direction-window pass', () => {
  it('does not place a task through a container the wizard did not create', async () => {
    // block_type NULL — the bug's trigger — and deliberately UNTAGGED, for the same
    // reason as the wizard-shaped case below: a container whose coordinates MATCH the
    // task gets claimed by a filling pass and the task lands inside it, which is a
    // legitimate overlap and says nothing about the obstacle rule. Untagged, no pass
    // can claim it, so an overlap can only mean the engine placed straight through.
    container({ start: '09:00', end: '10:00', tag: null });
    stageTask('ship the release');

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placementOf('ship the release');
    expect(p, 'the task was not placed at all').toBeDefined();
    expect(p!.parent).toBeNull();
    expect(overlaps(p!, '09:00', '10:00'), `placed at ${p!.start}–${p!.end}, through the Time Block`).toBe(false);
  });

  it('still holds the slot for a wizard-shaped container', async () => {
    // The behaviour that already worked, kept honest: a change that fixed NULL by
    // breaking 'scheduled' would pass the test above and fail this one.
    //
    // Deliberately UNTAGGED. A tagged `scheduled` container is a Plan, so Pass 1 fills
    // it and the task lands INSIDE — a legitimate overlap that would say nothing about
    // the obstacle rule. With no tag it is fillable by nothing and is purely an
    // obstacle, which is the arm under test.
    container({ start: '09:00', end: '10:00', blockType: 'scheduled', tag: null });
    stageTask('ship the release');

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placementOf('ship the release')!;
    expect(p.parent).toBeNull();
    expect(overlaps(p, '09:00', '10:00')).toBe(false);
  });

  it('places a task INSIDE a tagged Plan rather than around it', async () => {
    // The distinction the tests above depend on: holding a slot stops the engine placing
    // a BARE task through a container, not placing a member inside one.
    const tb = container({ start: '09:00', end: '10:00', blockType: 'scheduled', tag: 'work' });
    stageTask('ship the release');

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placementOf('ship the release')!;
    expect(p.parent, 'a tagged Plan should have claimed this task').toBe(tb);
    expect(p.start).toBe('09:00');
  });

  it('holds the slot in the workday fallback fill too', async () => {
    // Pass 2b, the other `includePlans` caller. A direction-less task never reaches the
    // window pass, so this exercises the fallback specifically.
    sqlite.prepare(`UPDATE scheduling_prefs SET auto_fill_workday = 1 WHERE owner_id = ?`).run(OWNER);
    container({ start: '09:00', end: '10:00' });
    const id = (sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority)
       VALUES (uuid7(), 'untagged work', ?, 'open', 60, 3) RETURNING id`,
    ).get(OWNER) as { id: string }).id;
    sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`)
      .run(OWNER, id);

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placementOf('untagged work');
    expect(p, 'the task was not placed at all').toBeDefined();
    expect(overlaps(p!, '09:00', '10:00')).toBe(false);
  });
});

describe('rows that are Time Blocks but occupy no minutes', () => {
  // Same geometry, same window, opposite expectation — each of these must leave 09:00
  // free, or the fix would have started blocking time nothing is using.
  //
  // All UNTAGGED, and the parent assertion is load-bearing: if one of these shapes ever
  // became a real container, the L02-first pass would nest the task INSIDE it at 09:00
  // and a start-time-only assertion would still read 09:00 and pass. Untagged, nothing
  // can claim it; the parent check catches it anyway if something tries.

  it('a someday concept holds nothing — it is parked, not placed', async () => {
    container({ start: '09:00', end: '10:00', blockType: 'someday', tag: null });
    stageTask('ship the release');

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placementOf('ship the release')!;
    expect(p.parent).toBeNull();
    expect(p.start).toBe('09:00');
  });

  it('an all-day row holds nothing — it lives in the header lane', async () => {
    // Its `end_at` is start + duration, an artifact of the notNull column rather than a
    // span; blocking on it would delete an hour nothing is using.
    container({ start: '09:00', end: '10:00', allDay: true, tag: null });
    stageTask('ship the release');

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placementOf('ship the release')!;
    expect(p.parent).toBeNull();
    expect(p.start).toBe('09:00');
  });

  it('a recurrence TEMPLATE holds nothing — it is never on any day', async () => {
    // A rule with no parent is never rendered; only its materialized instances are.
    container({ start: '09:00', end: '10:00', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO', tag: null });
    stageTask('ship the release');

    await placeFlightPlan(OWNER, { date: DAY });

    const p = placementOf('ship the release')!;
    expect(p.parent).toBeNull();
    expect(p.start).toBe('09:00');
  });

  it('a materialized INSTANCE of that rule does hold its slot', async () => {
    // The mirror of the test above: instances are real blocks on the day.
    const template = container({ start: '08:00', end: '08:30', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO', title: 'template', tag: null });
    // Untagged for the same reason as above — an instance IS a real container, so a
    // matching one would be filled rather than flowed around.
    container({ start: '09:00', end: '10:00', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO', recurrenceParentId: template, title: 'instance', tag: null });
    stageTask('ship the release');

    await placeFlightPlan(OWNER, { date: DAY });

    expect(overlaps(placementOf('ship the release')!, '09:00', '10:00')).toBe(false);
  });
});

describe('"Keep working" respects the same rung', () => {
  /** A plain task block to extend. */
  function taskBlock(start: string, end: string): string {
    return (sqlite.prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_auto, is_locked, source_kind, status)
       VALUES (uuid7(), ?, 'writing', 'task', ?, ?, 0, 0, 'manual', 'planned') RETURNING id`,
    ).get(OWNER, at(start), at(end)) as { id: string }).id;
  }

  it('is blocked by a container the wizard did not create, rather than shoving through it', async () => {
    const block = taskBlock('09:00', '10:00');
    const tb = container({ start: '10:00', end: '11:00', title: 'Deep work' });

    const r = await extendBlock(block, 30, {}, OWNER);

    expect(r.fits, 'the extension silently ran through a Time Block').toBe(false);
    expect(r.blockedBy?.block_id).toBe(tb);
  });

  it('is not blocked by a someday concept parked in the way', async () => {
    const block = taskBlock('09:00', '10:00');
    container({ start: '10:00', end: '11:00', blockType: 'someday' });

    const r = await extendBlock(block, 30, {}, OWNER);

    expect(r.fits).toBe(true);
    expect(r.blockedBy).toBeNull();
  });
});
