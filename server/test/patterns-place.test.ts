import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { placePatternOnDay } from '../src/engine/patterns-place.js';

/**
 * Pattern → board placement (PR-C+, Phase C). The new write path that replaces
 * "stage pattern into the flight-plan": a pattern's member tasks land as task
 * blocks directly on the day's grid, idempotently via a (source_kind='pattern',
 * source_ref=patternId, day-bounds) marker on time_blocks.
 */

const OWNER = 1;
const DAY = '2026-06-22'; // a Monday

function insertTask(title: string, est = 30, tag?: string): number {
  const id = (sqlite
    .prepare(`INSERT INTO tasks (title, owner_id, status, estimated_minutes, priority) VALUES (?, ?, 'open', ?, 3) RETURNING id`)
    .get(title, OWNER, est) as { id: number }).id;
  if (tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: number } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (name) VALUES (?) RETURNING id`).get(tag) as { id: number };
    sqlite.prepare(`INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)`).run(id, tg.id);
  }
  return id;
}
function insertPattern(typeName: string, name: string, taskIds: number[]): number {
  const ty = sqlite.prepare(`SELECT id FROM pattern_types WHERE name = ? AND owner_id = ?`).get(typeName, OWNER) as { id: number };
  const pid = (sqlite
    .prepare(`INSERT INTO patterns (owner_id, type_id, name) VALUES (?, ?, ?) RETURNING id`)
    .get(OWNER, ty.id, name) as { id: number }).id;
  taskIds.forEach((tid, i) =>
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(pid, tid, i),
  );
  return pid;
}

const patternBlocks = (patternId: number) =>
  sqlite
    .prepare(`SELECT title, start_at, end_at, parent_block_id, task_id FROM time_blocks WHERE source_kind = 'pattern' AND source_ref = ? ORDER BY start_at`)
    .all(String(patternId)) as { title: string; start_at: string; end_at: string; parent_block_id: number | null; task_id: number }[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM pattern_tasks; DELETE FROM patterns WHERE id > 0;`);
});

describe('placePatternOnDay — gap math + member redirection', () => {
  it('places two tasks (30m + 60m) into an empty workday window — 2 blocks, marked pattern', async () => {
    const t1 = insertTask('Plan day', 30);
    const t2 = insertTask('Deep focus', 60);
    const pid = insertPattern('Routine', 'Morning Routine', [t1, t2]);

    const r = placePatternOnDay(OWNER, pid, { date: DAY });
    expect(r).toMatchObject({ patternId: pid, date: DAY, placed: 2, unplaced: 0, blocksCreated: 2, skippedAlreadyPlaced: false });
    const blocks = patternBlocks(pid);
    expect(blocks.map((b) => b.title)).toEqual(['Plan day', 'Deep focus']);
    // parent NULL when not scoped to a Plan
    expect(blocks.every((b) => b.parent_block_id === null)).toBe(true);
  });

  it('idempotency: a 2nd call same day returns skippedAlreadyPlaced and inserts no rows', async () => {
    const t = insertTask('Plan day', 30);
    const pid = insertPattern('Routine', 'X', [t]);
    placePatternOnDay(OWNER, pid, { date: DAY });
    const r2 = placePatternOnDay(OWNER, pid, { date: DAY });
    expect(r2.skippedAlreadyPlaced).toBe(true);
    expect(r2.blocksCreated).toBe(0);
    expect(patternBlocks(pid).length).toBe(1);
  });

  it('self-heal: delete the placed blocks, re-run → succeeds (marker is read from time_blocks, not stored)', async () => {
    const t = insertTask('Plan day', 30);
    const pid = insertPattern('Routine', 'X', [t]);
    placePatternOnDay(OWNER, pid, { date: DAY });
    sqlite.exec(`DELETE FROM time_blocks WHERE source_kind = 'pattern'`);
    const r = placePatternOnDay(OWNER, pid, { date: DAY });
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

    placePatternOnDay(OWNER, pid, { date: DAY, blockId: plan.id });
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
      .prepare(`INSERT INTO tasks (title, owner_id, status, estimated_minutes, recurrence_rule, recurrence_dtstart, is_habit) VALUES ('Drink water', ?, 'recurring', 15, 'FREQ=DAILY', '2026-06-22T12:00:00Z', 1) RETURNING id`)
      .get(OWNER) as { id: number }).id;
    const instance = (sqlite
      .prepare(`INSERT INTO tasks (title, owner_id, status, estimated_minutes, recurrence_parent_id, occurrence_date) VALUES ('Drink water', ?, 'open', 15, ?, ?) RETURNING id`)
      .get(OWNER, template, DAY) as { id: number }).id;
    const pid = insertPattern('Habit', 'Hydration', [template]);

    placePatternOnDay(OWNER, pid, { date: DAY });
    const blocks = patternBlocks(pid);
    expect(blocks.length).toBe(1);
    expect(blocks[0].task_id).toBe(instance); // not the template
  });

  it('locked block in the middle of the workday forces fits around it — both tasks still placed', async () => {
    const t1 = insertTask('Task A', 30);
    const t2 = insertTask('Task B', 30);
    const pid = insertPattern('Routine', 'Pair', [t1, t2]);

    sqlite
      .prepare(`INSERT INTO time_blocks (title, block_kind, start_at, end_at, is_locked, is_auto, status) VALUES ('Meeting', 'task', ?, ?, 1, 0, 'planned')`)
      .run(`${DAY}T10:00:00.000Z`, `${DAY}T11:00:00.000Z`);

    placePatternOnDay(OWNER, pid, { date: DAY });
    expect(patternBlocks(pid).length).toBe(2);
  });
});

describe('POST /api/patterns/:id/place-today', () => {
  it('returns { result, blocks: [...] } and broadcasts via the API', async () => {
    const t = insertTask('Plan day', 30);
    const pid = insertPattern('Routine', 'X', [t]);
    const r = await api(srv.url, `/api/patterns/${pid}/place-today`, { method: 'POST', json: { date: DAY } });
    expect(r.status).toBe(200);
    expect(r.body.result.patternId).toBe(pid);
    expect(r.body.blocks.length).toBe(1);
    expect(r.body.blocks[0].title).toBe('Plan day');
  });

  it('404 for an unknown pattern id', async () => {
    expect((await api(srv.url, '/api/patterns/999999/place-today', { method: 'POST', json: {} })).status).toBe(404);
  });
});
