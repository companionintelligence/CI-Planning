import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';
import { placeTasksInBlock } from '../src/engine/blocks-place.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';

/**
 * Phase AD server slices.
 *
 * AD1 — task_time is authoritative in the flight-plan: a staged task with a task_time on
 * the placement day is PINNED at exactly (day, task_time) via the start-anchored path and
 * excluded from the gap-packer; time-LESS staged tasks pack around the pin.
 *
 * AD2 — a task dropped into a direction-tagged container inherits that direction as its
 * level-1 primary (unless it already has one) and the child block's `tag` mirrors it.
 *
 * Prefs baseline (resetDb): tz UTC, workday 09:00–18:00, min_break 10 — so expected
 * instants are plain UTC wall times.
 */

const OWNER = SYSTEM_OWNER;


let srv: TestServer;
beforeAll(async () => {
  // Pin the clock (Date only) to NOON of the real current day. AD1 pins a task at 14:00
  // on "today" inside the 09:00–18:00 workday — with the real clock, any run after
  // 14:00Z can't place the pin (the ≥now clamp) and after 18:00Z nothing places at all,
  // so the test was an hour-of-day bomb. Precedent: recurrence-horizon.test.ts.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`));
  srv = await startTestServer();
});
afterAll(async () => { await srv.close(); vi.useRealTimers(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
});

function insertTask(title: string, opts: { est?: number; scheduledFor?: string; taskTime?: string } = {}): string {
  return (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority, scheduled_for, task_time)
       VALUES (uuid7(), ?, ?, 'open', ?, 3, ?, ?) RETURNING id`,
    )
    .get(title, OWNER, opts.est ?? 60, opts.scheduledFor ?? null, opts.taskTime ?? null) as { id: string }).id;
}
function stage(taskId: string): void {
  sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
}
function taskBlocks(taskId: string): { start_at: string; end_at: string; is_auto: number; tag: string | null }[] {
  return sqlite
    .prepare(`SELECT start_at, end_at, is_auto, tag FROM time_blocks WHERE task_id = ? AND block_kind = 'task' ORDER BY start_at`)
    .all(taskId) as { start_at: string; end_at: string; is_auto: number; tag: string | null }[];
}
/** A base direction tag row (work/home/community) for the owner. */
function directionTag(name: string): string {
  const existing = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction'`).get(OWNER, name) as { id: string } | undefined;
  if (existing) return existing.id;
  return (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'direction') RETURNING id`).get(OWNER, name) as { id: string }).id;
}
function taskLevel1Directions(taskId: string): string[] {
  return (sqlite
    .prepare(
      `SELECT tg.name FROM entity_tags et JOIN tags tg ON tg.id = et.tag_id
        WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1 AND tg.kind = 'direction'
        ORDER BY tg.name`,
    )
    .all(taskId) as { name: string }[]).map((r) => r.name);
}
function insertContainer(startISO: string, endISO: string, tag: string | null): string {
  return (sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, block_type, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id, tag)
       VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', ?, ?, 0, 0, 'manual', 'planned', ?, ?) RETURNING id`,
    )
    .get(startISO, endISO, OWNER, tag) as { id: string }).id;
}

describe('AD1 — flight-plan pins a task_time task while packing a time-less one', () => {
  it('pins the timed task at its exact time; the time-less task packs elsewhere without overlap', () => {

      const day = new Date().toISOString().slice(0, 10); // UTC day — owner-tz=UTC baseline; avoids the near-midnight flake
      const timed = insertTask('Meet client', { est: 60, scheduledFor: day, taskTime: '14:00' });
      const flexible = insertTask('Deep work', { est: 60 }); // no time, no scheduled day → workday fill
      stage(timed);
      stage(flexible);

      placeFlightPlan(OWNER, { date: day, silent: true });

      const pinned = taskBlocks(timed);
      expect(pinned.length).toBe(1);
      // Pinned exactly at 14:00 — task_time is authoritative (not packed at 09:00).
      expect(pinned[0].start_at).toBe(`${day}T14:00:00.000Z`);
      expect(pinned[0].end_at).toBe(`${day}T15:00:00.000Z`);
      expect(pinned[0].is_auto).toBe(0); // user-intent block

      const packed = taskBlocks(flexible);
      expect(packed.length).toBe(1);
      // The flexible task packs into the workday and never overlaps the 14:00–15:00 pin.
      const overlaps = packed[0].start_at < `${day}T15:00:00.000Z` && packed[0].end_at > `${day}T14:00:00.000Z`;
      expect(overlaps).toBe(false);

  });

  it('a timed task whose day ≠ placement date is NOT pinned on this day (packs normally, no pin block)', () => {

      const day = new Date().toISOString().slice(0, 10); // UTC day — owner-tz=UTC baseline; avoids the near-midnight flake
      const other = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      const timedOtherDay = insertTask('Future meeting', { est: 60, scheduledFor: other, taskTime: '14:00' });
      stage(timedOtherDay);

      placeFlightPlan(OWNER, { date: day, silent: true });

      // No pin on `day` (its target day is `other`); nothing is placed at 14:00 today.
      const blocks = taskBlocks(timedOtherDay).filter((b) => b.start_at.startsWith(day));
      expect(blocks.every((b) => b.start_at !== `${day}T14:00:00.000Z`)).toBe(true);

  });
});

describe('AD2 — container → task direction inheritance (placeTasksInBlock)', () => {
  const DAY = '2026-06-22';
  const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

  it('a task added to a direction-tagged container inherits that direction (level 1) + block tag mirrors it', () => {
    directionTag('work');
    const c = insertContainer(at('09:00'), at('12:00'), 'work');
    const t = insertTask('Untagged task', { est: 30 });
    expect(taskLevel1Directions(t)).toEqual([]); // starts with no direction

    const r = placeTasksInBlock(OWNER, c, [t]);
    expect(r.placed).toBe(1);

    expect(taskLevel1Directions(t)).toEqual(['work']); // inherited
    const kids = taskBlocks(t);
    expect(kids.length).toBe(1);
    expect(kids[0].tag).toBe('work'); // block tag mirrors the container direction
  });

  it("never overrides a task's existing level-1 direction", () => {
    directionTag('work');
    const home = directionTag('home');
    const c = insertContainer(at('09:00'), at('12:00'), 'work');
    const t = insertTask('Already home', { est: 30 });
    sqlite.prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(t, home);

    placeTasksInBlock(OWNER, c, [t]);

    // Its own 'home' direction survives — the container's 'work' does NOT get added.
    expect(taskLevel1Directions(t)).toEqual(['home']);
  });

  it('a container with no direction tag leaves the task untouched (block tag stays null)', () => {
    const c = insertContainer(at('09:00'), at('12:00'), null);
    const t = insertTask('No inherit', { est: 30 });
    placeTasksInBlock(OWNER, c, [t]);
    expect(taskLevel1Directions(t)).toEqual([]);
    expect(taskBlocks(t)[0].tag).toBeNull();
  });
});
