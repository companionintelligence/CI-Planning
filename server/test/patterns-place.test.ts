import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer, seedFallbackFillWindow } from './helpers.js';
import { placePatternOnDay } from '../src/engine/patterns-place.js';

/**
 * Pattern → board placement (PR-C+, Phase C). The new write path that replaces
 * "stage pattern into the flight-plan": a pattern's member tasks land as task
 * blocks directly on the day's grid, idempotently via a (source_kind='pattern',
 * source_ref=patternId, day-bounds) marker on time_blocks.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22'; // a Monday

function insertTask(title: string, est = 30, tag?: string): string {
  const id = (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
    .get(title, OWNER, est) as { id: string }).id;
  if (tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), ?, ?) RETURNING id`).get(tag, OWNER) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}
function insertPattern(typeName: string, name: string, taskIds: string[]): string {
  const ty = sqlite.prepare(`SELECT id FROM pattern_types WHERE name = ? AND owner_id = ?`).get(typeName, OWNER) as { id: string };
  const pid = (sqlite
    .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(OWNER, ty.id, name) as { id: string }).id;
  taskIds.forEach((tid, i) =>
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(pid, tid, i),
  );
  return pid;
}

// Task blocks the placement produced (excludes the routine container, which is a
// block_kind='timeblock' wrapper added for free placements).
const patternBlocks = (patternId: string) =>
  sqlite
    .prepare(`SELECT title, start_at, end_at, parent_block_id, task_id FROM time_blocks WHERE source_kind = 'pattern' AND source_ref = ? AND block_kind = 'task' ORDER BY start_at`)
    .all(patternId) as { title: string; start_at: string; end_at: string; parent_block_id: string | null; task_id: string }[];

// The routine container (Plan wrapper) for a freely-placed pattern, if any.
const patternContainer = (patternId: string) =>
  sqlite
    .prepare(`SELECT id, title, tag, start_at, end_at FROM time_blocks WHERE source_kind = 'pattern' AND source_ref = ? AND block_kind = 'timeblock'`)
    .get(patternId) as { id: string; title: string; tag: string | null; start_at: string; end_at: string } | undefined;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  seedFallbackFillWindow(); // 0156: Auto's fallback fill needs work/community windows
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM pattern_tasks; DELETE FROM patterns WHERE id > 0;`);
});

describe('placePatternOnDay — gap math + member redirection', () => {
  it('places two tasks (30m + 60m) into an empty workday window — 2 blocks, marked pattern', async () => {
    const t1 = insertTask('Plan day', 30);
    const t2 = insertTask('Deep focus', 60);
    const pid = insertPattern('Routine', 'Morning Routine', [t1, t2]);

    const r = await placePatternOnDay(OWNER, pid, { date: DAY });
    expect(r).toMatchObject({ patternId: pid, date: DAY, placed: 2, unplaced: 0, blocksCreated: 2, skippedAlreadyPlaced: false });
    const blocks = patternBlocks(pid);
    expect(blocks.map((b) => b.title)).toEqual(['Plan day', 'Deep focus']);
    // Free placement wraps the routine in a container and parents the tasks to it, so
    // they move together (PR-C grouped movement) — "a container like a time-block".
    const container = patternContainer(pid);
    expect(container).toBeTruthy();
    expect(container!.title).toBe('Morning Routine');
    expect(blocks.every((b) => b.parent_block_id === container!.id)).toBe(true);
    // Contiguous: every task sits within the container's span.
    expect(blocks[0].start_at >= container!.start_at).toBe(true);
    expect(blocks[blocks.length - 1].end_at <= container!.end_at).toBe(true);
  });

  it('idempotency: a 2nd call same day returns skippedAlreadyPlaced and inserts no rows', async () => {
    const t = insertTask('Plan day', 30);
    const pid = insertPattern('Routine', 'X', [t]);
    await placePatternOnDay(OWNER, pid, { date: DAY });
    const r2 = await placePatternOnDay(OWNER, pid, { date: DAY });
    expect(r2.skippedAlreadyPlaced).toBe(true);
    expect(r2.blocksCreated).toBe(0);
    expect(patternBlocks(pid).length).toBe(1);
  });

  it('self-heal: delete the placed blocks, re-run → succeeds (marker is read from time_blocks, not stored)', async () => {
    const t = insertTask('Plan day', 30);
    const pid = insertPattern('Routine', 'X', [t]);
    await placePatternOnDay(OWNER, pid, { date: DAY });
    sqlite.exec(`DELETE FROM time_blocks WHERE source_kind = 'pattern'`);
    const r = await placePatternOnDay(OWNER, pid, { date: DAY });
    expect(r.skippedAlreadyPlaced).toBe(false);
    expect(r.blocksCreated).toBe(1);
  });

  it('scopes to a Plan via blockId: tasks land inside the Plan window AND inherit parent_block_id (PR-C grouped movement)', async () => {
    const t1 = insertTask('Errand A', 30, 'errands');
    const t2 = insertTask('Work', 30, 'work');
    const pid = insertPattern('Routine', 'Mixed', [t1, t2]);

    // a tag-filtered Plan from 14:00–17:00 UTC
    const plan = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Errands', block_kind: 'timeblock', tag: 'errands', start_at: `${DAY}T14:00:00.000Z`, end_at: `${DAY}T17:00:00.000Z` },
    })).body.block;

    await placePatternOnDay(OWNER, pid, { date: DAY, blockId: plan.id });
    const blocks = patternBlocks(pid);
    // The work-tagged task is filtered out by the Plan's tag scope.
    expect(blocks.map((b) => b.title)).toEqual(['Errand A']);
    expect(blocks[0].parent_block_id).toBe(plan.id);
    expect(blocks[0].start_at >= `${DAY}T14:00:00.000Z`).toBe(true);
    expect(blocks[0].end_at <= `${DAY}T17:00:00.000Z`).toBe(true);
  });

  it('redirects a recurrence template to today’s instance when one exists', async () => {
    // a habit task template + its materialized instance for today
    const template = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, subtype, recurrence_rule, recurrence_dtstart) VALUES (uuid7(), 'Drink water', ?, 'recurring', 15, 'habit', 'FREQ=DAILY', '2026-06-22T12:00:00Z') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    const instance = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, recurrence_parent_id, occurrence_date) VALUES (uuid7(), 'Drink water', ?, 'open', 15, ?, ?) RETURNING id`)
      .get(OWNER, template, DAY) as { id: string }).id;
    const pid = insertPattern('Habit', 'Hydration', [template]);

    await placePatternOnDay(OWNER, pid, { date: DAY });
    const blocks = patternBlocks(pid);
    expect(blocks.length).toBe(1);
    expect(blocks[0].task_id).toBe(instance); // not the template
  });

  // ── AF-11 — the container stamp comes from the DERIVED direction union ────────
  // (routines author no tags; patterns.tag is NULL post-0120 and never read here).
  const directionTagId = (name: string): string => {
    const ex = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ?`).get(OWNER, name) as { id: string } | undefined;
    return ex ? ex.id : (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'direction') RETURNING id`).get(OWNER, name) as { id: string }).id;
  };
  const attachDirection = (taskId: string, name: string) =>
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(taskId, directionTagId(name));
  const containerEntityTags = (containerId: string) =>
    sqlite.prepare(`SELECT t.name, et.level FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_kind = 'time_block' AND et.entity_id = ? ORDER BY et.level, t.name`).all(containerId) as { name: string; level: number }[];

  it('AF-11: free-place stamps the FIRST derived direction into tag + the rest as level-2 secondary (no comma-join)', async () => {
    const t1 = insertTask('Work thing', 30); attachDirection(t1, 'work');
    const t2 = insertTask('Home thing', 30); attachDirection(t2, 'home');
    const pid = insertPattern('Routine', 'Mixed directions', [t1, t2]);

    await placePatternOnDay(OWNER, pid, { date: DAY });
    const container = patternContainer(pid);
    expect(container).toBeTruthy();
    // Derived union is name-sorted → 'home' is first; the rest never comma-join.
    expect(container!.tag).toBe('home');
    expect(containerEntityTags(container!.id)).toEqual([
      { name: 'home', level: 1 },
      { name: 'work', level: 2 },
    ]);
  });

  it('AF-11: no derived direction → no stamp (container tag NULL, no entity_tags)', async () => {
    const t = insertTask('Untagged member', 30);
    const pid = insertPattern('Routine', 'Plain', [t]);
    await placePatternOnDay(OWNER, pid, { date: DAY });
    const container = patternContainer(pid);
    expect(container!.tag).toBeNull();
    expect(containerEntityTags(container!.id)).toEqual([]);
  });

  it('AF-11 regression: placement is byte-identical whether or not the routine carries a LEGACY authored tag', async () => {
    // Placement never read the routine's own tag — prove it stays true: two routines
    // with identical members, one with a raw legacy patterns.tag, place at the same
    // wall times (compared across two days so they don't compete for gaps).
    const timesOf = (pid: string) => patternBlocks(pid).map((b) => [b.title, b.start_at.slice(11), b.end_at.slice(11)]);
    const a1 = insertTask('Step 1', 30); const a2 = insertTask('Step 2', 60);
    const clean = insertPattern('Routine', 'Twin', [a1, a2]);
    const b1 = insertTask('Step 1', 30); const b2 = insertTask('Step 2', 60);
    const legacy = insertPattern('Routine', 'Twin', [b1, b2]);
    sqlite.prepare(`UPDATE patterns SET tag = 'work,home' WHERE id = ?`).run(legacy);

    const rClean = await placePatternOnDay(OWNER, clean, { date: DAY });
    const rLegacy = await placePatternOnDay(OWNER, legacy, { date: '2026-06-23' });
    expect(rLegacy).toMatchObject({ placed: rClean.placed, unplaced: rClean.unplaced, blocksCreated: rClean.blocksCreated });
    expect(timesOf(legacy)).toEqual(timesOf(clean));
    // The legacy authored tag is NOT the stamp source — members are untagged → NULL.
    expect(patternContainer(legacy)!.tag).toBeNull();
  });

  it('locked block in the middle of the workday forces fits around it — both tasks still placed', async () => {
    const t1 = insertTask('Task A', 30);
    const t2 = insertTask('Task B', 30);
    const pid = insertPattern('Routine', 'Pair', [t1, t2]);

    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, status, owner_id) VALUES (uuid7(), 'Meeting', 'task', ?, ?, 1, 0, 'planned', ?)`)
      .run(`${DAY}T10:00:00.000Z`, `${DAY}T11:00:00.000Z`, OWNER);

    await placePatternOnDay(OWNER, pid, { date: DAY });
    expect(patternBlocks(pid).length).toBe(2);
  });

  // ── L01 direction windows + AD1 pins ─────────────────────────────────────────
  // The free path used to place into `workday_start..workday_end` unconditionally,
  // which IS the seeded `work` window — so home/community routines were packed into
  // work hours and wall-clock pins were ignored outright.
  const insertPinned = (title: string, est: number, time: string): string =>
    (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority, task_time) VALUES (uuid7(), ?, ?, 'open', ?, 3, ?) RETURNING id`)
      .get(title, OWNER, est, time) as { id: string }).id;
  // The fixture ships NO pattern_blocks (a real owner gets them from provisionOwner),
  // so L01 is unconfigured by default — which is exactly why every test above lands in
  // the workday. A test that wants the rule must state the windows itself.
  const setWindow = (dir: string, start: string, end: string, dayType = 'workday') =>
    sqlite
      .prepare(`INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time) VALUES (uuid7(), ?, ?, ?, ?, ?)`)
      .run(OWNER, directionTagId(dir), dayType, start, end);

  it('L01: an unpinned home routine lands in a HOME window, never the work window', async () => {
    // Mirrors the shipped default shape: home mornings + evenings, work 09:00–18:00.
    setWindow('home', '07:00', '08:00');
    setWindow('home', '18:00', '23:00');
    setWindow('work', '09:00', '18:00');
    const t = insertTask('Tidy kitchen', 30); attachDirection(t, 'home');
    const pid = insertPattern('Routine', 'Home care', [t]);

    await placePatternOnDay(OWNER, pid, { date: DAY });
    const b = patternBlocks(pid)[0];
    expect(b).toBeTruthy();
    const hhmm = (iso: string) => iso.slice(11, 16);
    const inHome =
      (hhmm(b.start_at) >= '07:00' && hhmm(b.end_at) <= '08:00') ||
      (hhmm(b.start_at) >= '18:00' && hhmm(b.end_at) <= '23:00');
    expect(inHome).toBe(true);
    // The bug this fixes: it used to land inside 09:00–18:00, the WORK window.
    expect(hhmm(b.start_at) >= '09:00' && hhmm(b.start_at) < '18:00').toBe(false);
  });

  it('L01: a community routine uses the community window, not the workday', async () => {
    setWindow('community', '08:00', '09:00');
    setWindow('work', '09:00', '18:00');
    const t = insertTask('Gym', 60); attachDirection(t, 'community');
    const pid = insertPattern('Routine', 'Gym', [t]);

    await placePatternOnDay(OWNER, pid, { date: DAY });
    const b = patternBlocks(pid)[0];
    expect(b.start_at).toBe(`${DAY}T08:00:00.000Z`);
    expect(b.end_at).toBe(`${DAY}T09:00:00.000Z`);
  });

  it('L02 overrides L01: scoped to a Plan, the Plan span wins over the direction windows', async () => {
    setWindow('home', '07:00', '08:00'); // would otherwise force the morning
    const t = insertTask('Tidy kitchen', 30); attachDirection(t, 'home');
    const pid = insertPattern('Routine', 'Home care', [t]);
    const plan = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Evening', block_kind: 'timeblock', tag: 'home', start_at: `${DAY}T19:00:00.000Z`, end_at: `${DAY}T21:00:00.000Z` },
    })).body.block;

    await placePatternOnDay(OWNER, pid, { date: DAY, blockId: plan.id });
    const b = patternBlocks(pid)[0];
    expect(b.start_at >= `${DAY}T19:00:00.000Z`).toBe(true);
    expect(b.end_at <= `${DAY}T21:00:00.000Z`).toBe(true);
  });

  it('L01: no direction → the workday fallback still applies (rule nobody configured)', async () => {
    const t = insertTask('Untargeted', 30);
    const pid = insertPattern('Routine', 'Plain', [t]);
    await placePatternOnDay(OWNER, pid, { date: DAY });
    const b = patternBlocks(pid)[0];
    expect(b.start_at >= `${DAY}T09:00:00.000Z`).toBe(true);
    expect(b.end_at <= `${DAY}T18:00:00.000Z`).toBe(true);
  });

  it('AD1: a pinned member lands at EXACTLY its wall clock, not the next free gap', async () => {
    const t = insertPinned('Dinner', 45, '18:30'); attachDirection(t, 'home');
    const pid = insertPattern('Habit', 'Dinner', [t]);

    await placePatternOnDay(OWNER, pid, { date: DAY });
    const b = patternBlocks(pid)[0];
    expect(b.start_at).toBe(`${DAY}T18:30:00.000Z`);
    expect(b.end_at).toBe(`${DAY}T19:15:00.000Z`);
  });

  it('regression: placing a pinned habit does NOT overwrite its task_time', async () => {
    // The corruption this fixes: syncTaskFromBlock mirrored the PACKED slot back into
    // task_time, so an 18:30 dinner returned as 10:20 and every later run re-packed
    // from the corrupted value. The engine mirror writes scheduled_for only.
    const t = insertPinned('Dinner', 45, '18:30'); attachDirection(t, 'home');
    const pid = insertPattern('Habit', 'Dinner', [t]);

    await placePatternOnDay(OWNER, pid, { date: DAY });
    const row = sqlite.prepare(`SELECT task_time, scheduled_for FROM tasks WHERE id = ?`).get(t) as
      { task_time: string | null; scheduled_for: string | null };
    expect(row.task_time).toBe('18:30');   // the pin survives its own placement
    expect(row.scheduled_for).toBe(DAY);   // the day is still mirrored
  });

  it('a pinned and an unpinned member coexist: the pin holds, the rest packs around it', async () => {
    const pinnedT = insertPinned('Dinner', 45, '18:30'); attachDirection(pinnedT, 'home');
    const freeT = insertTask('Tidy kitchen', 30); attachDirection(freeT, 'home');
    const pid = insertPattern('Routine', 'Evening', [pinnedT, freeT]);

    await placePatternOnDay(OWNER, pid, { date: DAY });
    const blocks = patternBlocks(pid);
    expect(blocks.length).toBe(2);
    const dinner = blocks.find((b) => b.title === 'Dinner')!;
    const tidy = blocks.find((b) => b.title === 'Tidy kitchen')!;
    expect(dinner.start_at).toBe(`${DAY}T18:30:00.000Z`);
    // No overlap with the pin.
    expect(tidy.end_at <= dinner.start_at || tidy.start_at >= dinner.end_at).toBe(true);
  });
});

describe('POST /api/patterns/:id/place-today', () => {
  it('returns { result, blocks: [...] } and broadcasts via the API', async () => {
    const t = insertTask('Plan day', 30);
    const pid = insertPattern('Routine', 'X', [t]);
    const r = await api(srv.url, `/api/patterns/${pid}/place-today`, { method: 'POST', json: { date: DAY } });
    expect(r.status).toBe(200);
    expect(r.body.result.patternId).toBe(pid);
    // Returns the routine container + its task block(s) so the client can render the group.
    const taskBlocks = r.body.blocks.filter((b: any) => b.block_kind === 'task');
    expect(taskBlocks.length).toBe(1);
    expect(taskBlocks[0].title).toBe('Plan day');
    expect(r.body.blocks.some((b: any) => b.block_kind === 'timeblock')).toBe(true);
  });

  it('404 for an unknown pattern id', async () => {
    expect((await api(srv.url, '/api/patterns/999999/place-today', { method: 'POST', json: {} })).status).toBe(404);
  });
});
