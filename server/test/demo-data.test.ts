import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createOwner, resetDb, startTestServer, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { seedDemoData } from '../src/services/demo-data.js';
import { listBlocks } from '../src/services/blocks.js';

/**
 * The "Try with sample data" dataset.
 *
 * What these tests are really protecting is a PRIVACY property as much as a feature:
 * the set must be small, generic and complete on its own, because it replaced a path
 * that ran fixture email/calendar files through ingest and put their contents in front
 * of every new user and into every screenshot.
 *
 * TZ is pinned to UTC so "today" and the 07:30/13:00/18:30 pins are checkable without
 * the assertions drifting with the box's zone.
 */

const OWNER = SYSTEM_OWNER;
const MARKETPLACE_DOC = 'https://docs.ci.computer/docs/contributing/submitting-to-marketplace';

const taskRow = (title: string) =>
  sqlite.prepare(
    `SELECT id, title, notes, subtype, status, task_time, recurrence_rule, estimated_minutes, scheduled_for
       FROM tasks WHERE owner_id = ? AND title = ? ORDER BY status DESC LIMIT 1`,
  ).get(OWNER, title) as {
    id: string; title: string; notes: string | null; subtype: string | null; status: string;
    task_time: string | null; recurrence_rule: string | null; estimated_minutes: number | null;
    scheduled_for: string | null;
  } | undefined;

const directionsOf = (taskId: string) =>
  (sqlite.prepare(
    `SELECT g.name FROM entity_tags e JOIN tags g ON g.id = e.tag_id
      WHERE e.entity_kind = 'task' AND e.entity_id = ? AND g.kind = 'direction'`,
  ).all(taskId) as { name: string }[]).map((r) => r.name);

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
});

describe('the curated sample set', () => {
  it('installs the whole set in one call', async () => {
    const r = await seedDemoData(OWNER);
    // 3 loose + 3 objective steps; 5 habits; 1 objective; Deep work + its 3 members,
    // plus a container + task block for each of the three pinned meals.
    expect(r).toMatchObject({ tasks: 6, habits: 5, objectives: 1, blocks: 10 });
    expect(r.skipped).toBeUndefined();
  });

  it('gives each loose task its own direction and leaves it in the backlog', async () => {
    await seedDemoData(OWNER);
    for (const [title, direction] of [
      ['Review notes', 'work'],
      ['Get groceries', 'home'],
      ['Drop off donations', 'community'],
    ] as const) {
      const t = taskRow(title);
      expect(t, `${title} was not created`).toBeDefined();
      expect(directionsOf(t!.id)).toEqual([direction]);
      expect(t!.status).toBe('open');
      expect(t!.scheduled_for, `${title} should be unscheduled so Auto has work to do`).toBeNull();
    }
  });

  it('pins the meals to the clock and leaves the other habits for the engine', async () => {
    await seedDemoData(OWNER);
    for (const [title, time] of [['Breakfast', '07:30'], ['Lunch', '13:00'], ['Dinner', '18:30']] as const) {
      const t = taskRow(title);
      expect(t, `${title} was not created`).toBeDefined();
      expect(t!.subtype).toBe('habit');
      expect(t!.recurrence_rule).toMatch(/FREQ=DAILY/);
      expect(t!.task_time).toBe(time);
    }
    // Email triage and Gym repeat daily but carry no clock — a demo where everything is
    // already pinned demonstrates none of the scheduling.
    for (const title of ['Email triage', 'Gym']) {
      const t = taskRow(title);
      expect(t, `${title} was not created`).toBeDefined();
      expect(t!.subtype).toBe('habit');
      expect(t!.task_time).toBeNull();
    }
  });

  it('gives every habit a Habit pattern, like the app would', async () => {
    // The bridge promoteToHabit maintains. Seeding with raw INSERTs would skip it and
    // the routines surface would be quietly empty.
    await seedDemoData(OWNER);
    const n = sqlite.prepare(
      `SELECT COUNT(*) n FROM pattern_tasks pt
         JOIN patterns p ON p.id = pt.pattern_id
         JOIN pattern_types t ON t.id = p.type_id
        WHERE t.name = 'Habit' AND p.owner_id = ?`,
    ).get(OWNER) as { n: number };
    expect(n.n).toBe(5);
  });

  it('builds the objective with its three steps, and carries the marketplace link', async () => {
    await seedDemoData(OWNER);
    const obj = sqlite.prepare(`SELECT id, title FROM objectives WHERE owner_id = ?`).get(OWNER) as
      { id: string; title: string } | undefined;
    expect(obj?.title).toBe('Launch app in Companion-Hub');

    const linked = sqlite.prepare(
      `SELECT t.title, t.notes FROM objective_tasks ot JOIN tasks t ON t.id = ot.task_id
        WHERE ot.objective_id = ? ORDER BY t.title`,
    ).all(obj!.id) as { title: string; notes: string | null }[];
    expect(linked.map((t) => t.title).sort()).toEqual(
      ['Investigate Companion Memory Plug-In', 'Review Hub Requirements', 'Update App'],
    );
    const review = linked.find((t) => t.title === 'Review Hub Requirements');
    expect(review?.notes ?? '').toContain(MARKETPLACE_DOC);
  });

  it('puts the objective steps INSIDE a Deep work block on today', async () => {
    await seedDemoData(OWNER);
    const container = sqlite.prepare(
      `SELECT id, start_at, end_at FROM time_blocks
        WHERE owner_id = ? AND block_kind = 'timeblock' AND title = 'Deep work'`,
    ).get(OWNER) as { id: string; start_at: string; end_at: string } | undefined;
    expect(container, 'the Deep work block was not created').toBeDefined();

    // Today in the owner's zone (pinned UTC above), not the day this test was written.
    const today = new Date().toISOString().slice(0, 10);
    expect(container!.start_at.slice(0, 10)).toBe(today);
    expect(container!.start_at.slice(11, 16)).toBe('09:00');
    expect(container!.end_at.slice(11, 16)).toBe('11:00');

    const members = sqlite.prepare(
      `SELECT t.title FROM time_blocks b JOIN tasks t ON t.id = b.task_id
        WHERE b.parent_block_id = ? ORDER BY b.start_at`,
    ).all(container!.id) as { title: string }[];
    expect(members.map((m) => m.title)).toEqual(
      ['Review Hub Requirements', 'Update App', 'Investigate Companion Memory Plug-In'],
    );
  });

  it('places the block on the day it is seeded, not the day it was written', async () => {
    // The injected clock is the whole point: a demo hard-coded to a date shows an empty
    // calendar a week later.
    const pinned = new Date('2027-03-09T15:00:00.000Z');
    await seedDemoData(OWNER, pinned);
    const c = sqlite.prepare(
      `SELECT start_at FROM time_blocks WHERE owner_id = ? AND title = 'Deep work'`,
    ).get(OWNER) as { start_at: string };
    expect(c.start_at).toBe('2027-03-09T09:00:00.000Z'); // owner tz pinned to UTC above
  });

  it('members tile the block without overlapping', async () => {
    await seedDemoData(OWNER);
    const rows = sqlite.prepare(
      `SELECT b.start_at, b.end_at FROM time_blocks b
        WHERE b.parent_block_id = (SELECT id FROM time_blocks WHERE owner_id = ? AND title = 'Deep work')
        ORDER BY b.start_at`,
    ).all(OWNER) as { start_at: string; end_at: string }[];
    expect(rows).toHaveLength(3);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].start_at >= rows[i - 1].end_at, 'members overlap inside the block').toBe(true);
    }
  });
});

describe('the meals keep their clock', () => {
  /**
   * The regression this exists for: a habit becomes a routine Pattern, and
   * `patterns-place` PACKS routines into the workday window without reading
   * `task_time`. Seeded straight, breakfast/lunch/dinner came out at 11:10/11:50/12:30
   * and the placement overwrote today's pins.
   *
   * Reading a day range is what triggers `ensurePatternsForRange`, so the read below is
   * the point of the test, not a convenience — without it the packer never runs and this
   * would pass with the bug in.
   */
  it('pins them at 07:30 / 13:00 / 18:30 even after the routine packer runs', async () => {
    // The REAL today, deliberately: recurrence instances are materialized on a horizon
    // from now, so a pinned far-future clock has no instance for a meal block to attach
    // to and this would pass vacuously.
    await seedDemoData(OWNER);

    const day = new Date().toISOString().slice(0, 10);
    const from = `${day}T00:00:00.000Z`;
    const to = `${day}T23:59:59.999Z`;
    const blocks = await listBlocks(OWNER, { from, to }) as { title: string; start_at: string; block_kind: string }[];

    for (const [title, time] of [['Breakfast', '07:30'], ['Lunch', '13:00'], ['Dinner', '18:30']] as const) {
      const containers = blocks.filter((b) => b.title === title && b.block_kind === 'timeblock');
      expect(containers, `${title} should appear exactly once`).toHaveLength(1);
      expect(containers[0].start_at.slice(11, 16), `${title} lost its pin`).toBe(time);
    }
  });

  it('still lets the engine place the UNPINNED habits', async () => {
    // The other half of the demo: Email triage and Gym carry no clock, so the packer
    // choosing their slot is the feature, not a failure.
    await seedDemoData(OWNER);
    const day = new Date().toISOString().slice(0, 10);
    const blocks = await listBlocks(OWNER, { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` }) as
      { title: string; block_kind: string }[];
    for (const title of ['Email triage', 'Gym']) {
      expect(blocks.some((b) => b.title === title), `${title} was never placed`).toBe(true);
    }
  });
});

describe('pressing the button twice', () => {
  it('reports a skip and creates nothing the second time', async () => {
    await seedDemoData(OWNER);
    const count = () => (sqlite.prepare(`SELECT COUNT(*) n FROM tasks WHERE owner_id = ?`).get(OWNER) as { n: number }).n;
    const before = count();

    const again = await seedDemoData(OWNER);

    expect(again.skipped).toBe('Sample data is already loaded');
    expect(again).toMatchObject({ tasks: 0, habits: 0, objectives: 0, blocks: 0 });
    expect(count()).toBe(before);
  });
});

describe('owner scoping', () => {
  it('seeds only the owner it was asked about', async () => {
    createOwner(SECOND_OWNER_ID);
    await seedDemoData(OWNER);

    const otherTasks = sqlite.prepare(`SELECT COUNT(*) n FROM tasks WHERE owner_id = ?`).get(SECOND_OWNER_ID) as { n: number };
    const otherBlocks = sqlite.prepare(`SELECT COUNT(*) n FROM time_blocks WHERE owner_id = ?`).get(SECOND_OWNER_ID) as { n: number };
    expect(otherTasks.n).toBe(0);
    expect(otherBlocks.n).toBe(0);

    // …and the second owner can still get their own copy.
    const r = await seedDemoData(SECOND_OWNER_ID);
    expect(r.skipped).toBeUndefined();
    expect(r.objectives).toBe(1);
  });
});
