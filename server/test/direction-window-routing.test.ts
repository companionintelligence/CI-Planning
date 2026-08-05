import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';

/**
 * Auto Schedule must route each staged task into the availability window of ITS OWN
 * direction — Work into the work window, Home into home, Community into community — for
 * the day-type that date resolves to.
 *
 * Existing coverage exercises this one task at a time (start-anchored placement,
 * af11 tag-split, the direction-less workday fallback). What was missing is the shape a
 * user actually hits: several differently-directed tasks staged together, placed in one
 * Auto Schedule run, each landing in its own window and NOT in a sibling's. A pass that
 * routed everything into the first window, or ignored direction entirely and used the
 * generic workday fill, would satisfy every per-task test and still be wrong here.
 *
 * The windows below are the real seeded defaults (migration 0037 / provisionOwner), and
 * they are deliberately DISJOINT per direction, so "landed in the right window" is
 * unambiguous rather than coincidental overlap.
 */

const OWNER = SYSTEM_OWNER;
const WORKDAY = '2026-06-22'; // a Monday
const WEEKEND = '2026-06-20'; // a Saturday

/** Real default direction windows, keyed by day type. Disjoint within a day type. */
const DEFAULT_WINDOWS: Record<string, Record<string, [string, string][]>> = {
  workday: {
    home: [['07:00', '08:00'], ['18:00', '23:00']],
    work: [['09:00', '18:00']],
    community: [['08:00', '09:00']],
  },
  weekend: {
    work: [['10:00', '12:00']],
    community: [['08:00', '22:00']],
    home: [['08:00', '23:00']],
  },
};

function directionTagId(name: string): string {
  const found = sqlite
    .prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction'`)
    .get(OWNER, name) as { id: string } | undefined;
  if (found) return found.id;
  return (
    sqlite
      .prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, 'direction') RETURNING id`)
      .get(name, OWNER) as { id: string }
  ).id;
}

function seedWindows(dayType: string) {
  for (const [dir, ranges] of Object.entries(DEFAULT_WINDOWS[dayType])) {
    const tagId = directionTagId(dir);
    for (const [start, end] of ranges) {
      sqlite
        .prepare(
          `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
           VALUES (uuid7(), ?, ?, ?, ?, ?)`,
        )
        .run(OWNER, tagId, dayType, start, end);
    }
  }
}

/** A staged, open task carrying exactly one level-1 direction tag. */
function stageDirectedTask(title: string, direction: string, est = 30): string {
  const id = (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority)
         VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`,
      )
      .get(title, OWNER, est) as { id: string }
  ).id;
  sqlite
    .prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`)
    .run(id, directionTagId(direction));
  sqlite
    .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`)
    .run(OWNER, id);
  return id;
}

/** Where each auto-placed block for `title` actually landed, as HH:MM–HH:MM UTC. */
function placementOf(title: string): { start: string; end: string } | undefined {
  const row = sqlite
    .prepare(
      `SELECT b.start_at, b.end_at FROM time_blocks b
         JOIN tasks t ON t.id = b.task_id
        WHERE t.title = ? AND b.source_kind = 'agent'
        ORDER BY b.start_at LIMIT 1`,
    )
    .get(title) as { start_at: string; end_at: string } | undefined;
  if (!row) return undefined;
  const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16);
  return { start: hhmm(row.start_at), end: hhmm(row.end_at) };
}

/** True when [start,end) sits entirely inside one of `ranges`. */
function withinAnyRange(p: { start: string; end: string }, ranges: [string, string][]): boolean {
  return ranges.some(([s, e]) => p.start >= s && p.end <= e);
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM flight_plan; DELETE FROM pattern_blocks;');
  // UTC keeps window arithmetic readable; auto_fill_workday OFF so a generic workday
  // fill cannot rescue a task the direction routing failed to place — otherwise a
  // broken pass 2a would still look "placed".
  sqlite
    .prepare(
      `UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00',
              auto_fill_workday = 0 WHERE owner_id = ?`,
    )
    .run(OWNER);
});

describe('Auto Schedule — direction routing on a workday', () => {
  beforeEach(() => seedWindows('workday'));

  it('routes Work, Home and Community tasks each into their OWN window in one run', async () => {
    stageDirectedTask('ship the release', 'work');
    stageDirectedTask('empty the dishwasher', 'home');
    stageDirectedTask('call the neighbour', 'community');

    await placeFlightPlan(OWNER, { date: WORKDAY });

    const work = placementOf('ship the release');
    const home = placementOf('empty the dishwasher');
    const community = placementOf('call the neighbour');

    expect(work, 'work task was not placed at all').toBeDefined();
    expect(home, 'home task was not placed at all').toBeDefined();
    expect(community, 'community task was not placed at all').toBeDefined();

    expect(withinAnyRange(work!, DEFAULT_WINDOWS.workday.work), `work landed at ${work!.start}`).toBe(true);
    expect(withinAnyRange(home!, DEFAULT_WINDOWS.workday.home), `home landed at ${home!.start}`).toBe(true);
    expect(
      withinAnyRange(community!, DEFAULT_WINDOWS.workday.community),
      `community landed at ${community!.start}`,
    ).toBe(true);
  });

  it('does not spill a Home task into the Work window', async () => {
    // The windows are disjoint, so this is the sharpest single assertion: 07:00–08:00 or
    // 18:00–23:00, never 09:00–18:00.
    stageDirectedTask('fold laundry', 'home');

    await placeFlightPlan(OWNER, { date: WORKDAY });

    const p = placementOf('fold laundry');
    expect(p).toBeDefined();
    expect(withinAnyRange(p!, DEFAULT_WINDOWS.workday.work)).toBe(false);
    expect(withinAnyRange(p!, DEFAULT_WINDOWS.workday.home)).toBe(true);
  });

  it('places a Community task in its one-hour window, not the wide Work one', async () => {
    stageDirectedTask('volunteer email', 'community');

    await placeFlightPlan(OWNER, { date: WORKDAY });

    const p = placementOf('volunteer email');
    expect(p).toBeDefined();
    expect(p!.start >= '08:00' && p!.end <= '09:00', `landed ${p!.start}-${p!.end}`).toBe(true);
  });
});

describe('Auto Schedule — direction routing follows the day type', () => {
  it('uses the WEEKEND windows on a Saturday, not the workday ones', async () => {
    seedWindows('workday');
    seedWindows('weekend');
    // Work is 09:00–18:00 on a workday but only 10:00–12:00 at the weekend, so the day
    // type is observable from where the task lands.
    stageDirectedTask('weekend work catch-up', 'work');

    await placeFlightPlan(OWNER, { date: WEEKEND });

    const p = placementOf('weekend work catch-up');
    expect(p, 'work task was not placed on the weekend').toBeDefined();
    expect(withinAnyRange(p!, DEFAULT_WINDOWS.weekend.work), `landed ${p!.start}-${p!.end}`).toBe(true);
  });
});
