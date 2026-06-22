import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { up as up0037 } from '../src/db/migrations/0037_pattern_blocks.js';
import { newId } from '../src/lib/ids.js';

/**
 * Pattern-blocks (noun 8): direction-scoped scheduling windows. Tests cover the
 * migration, the CRUD API, and the direction-aware Pass 2 in the auto-scheduler.
 */

const OWNER = SYSTEM_OWNER;
// 2026-06-22 = Monday (workday); 2026-06-21 = Sunday (weekend)
const WEEKDAY = '2026-06-22';
const WEEKEND = '2026-06-21';

// Runtime code looks up pattern tags by kind='pattern' (post-0038 rename). The
// 0037-migration-isolation test, however, runs up0037 directly — which predates the
// rename and matches kind='direction' — so it seeds with that older value.
function seedDirections(kind: string = 'pattern'): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const name of ['home', 'work', 'community']) {
    ids[name] = (
      sqlite
        .prepare(`INSERT INTO tags (id, name, kind, is_base) VALUES (uuid7(), ?, ?, 1) RETURNING id`)
        .get(name, kind) as { id: string }
    ).id;
  }
  return ids;
}

function insertTask(title: string, est = 30, dirTagId?: string): string {
  const id = (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority)
         VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`,
      )
      .get(title, OWNER, est) as { id: string }
  ).id;
  if (dirTagId) {
    sqlite.prepare(`INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)`).run(id, dirTagId);
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, dirTagId);
  }
  return id;
}

function seedPatternBlock(dirTagId: string, dayType: string, start: string, end: string): void {
  sqlite
    .prepare(`INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(newId(), OWNER, dirTagId, dayType, start, end);
}

/** Insert a pattern_prefs row pinning a pattern's auto_fill toggle (other cols = defaults). */
function seedPatternPref(dirTagId: string, autoFill: boolean): void {
  sqlite
    .prepare(
      `INSERT INTO pattern_prefs (id, owner_id, pattern_tag_id, auto_fill, reminder_offsets, icon_shape, color_token)
       VALUES (?, ?, ?, ?, '[]', 'circle', 'primary')`,
    )
    .run(newId(), OWNER, dirTagId, autoFill ? 1 : 0);
}

function stageTask(taskId: string): void {
  sqlite
    .prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`)
    .run(OWNER, taskId);
}

const placedBlocks = () =>
  sqlite.prepare(`SELECT title, start_at, end_at FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1 ORDER BY start_at`).all() as {
    title: string;
    start_at: string;
    end_at: string;
  }[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM pattern_tasks; DELETE FROM patterns;`);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('0037 migration', () => {
  it('is idempotent (table already exists from server startup)', () => {
    expect(() => up0037(sqlite)).not.toThrow();
  });

  it('seeds default windows for the base directions when an owner has none', () => {
    // resetDb cleared tags (cascading pattern_blocks). Re-insert directions then run migration.
    // up0037 predates the 0038 rename, so it matches kind='direction'.
    const dirs = seedDirections('direction');
    up0037(sqlite);

    const rows = sqlite
      .prepare(`SELECT direction_tag_id, day_type, start_time, end_time FROM pattern_blocks WHERE owner_id = ? ORDER BY day_type, start_time`)
      .all(OWNER) as { direction_tag_id: string; day_type: string; start_time: string; end_time: string }[];

    // 3 directions × 2 day types × varying range counts = 10 total
    // workday: home×2, work×1, community×2 = 5; weekend: home×1, work×1, community×1 = 3... wait
    // workday: home (07-08, 18-23), work (09-18), community (08-09, 18-21) = 5 rows
    // weekend: home (08-23), work (10-12), community (08-22) = 3 rows => 8 total
    expect(rows.length).toBe(8);
    // work weekday window
    const workWd = rows.filter((r) => r.direction_tag_id === dirs.work && r.day_type === 'workday');
    expect(workWd).toHaveLength(1);
    expect(workWd[0]).toMatchObject({ start_time: '09:00', end_time: '18:00' });
    // home has 2 workday windows
    const homeWd = rows.filter((r) => r.direction_tag_id === dirs.home && r.day_type === 'workday');
    expect(homeWd).toHaveLength(2);
  });

  it('does not double-seed if pattern_blocks already exist for the owner', () => {
    const dirs = seedDirections();
    up0037(sqlite); // first seed
    const countAfterFirst = (sqlite.prepare(`SELECT COUNT(*) c FROM pattern_blocks WHERE owner_id = ?`).get(OWNER) as { c: number }).c;
    up0037(sqlite); // second call must be idempotent
    const countAfterSecond = (sqlite.prepare(`SELECT COUNT(*) c FROM pattern_blocks WHERE owner_id = ?`).get(OWNER) as { c: number }).c;
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(dirs.home).toBeTruthy(); // appease eslint
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/pattern-blocks', () => {
  it('returns both day types with ranges grouped by dirTagId', async () => {
    const dirs = seedDirections();
    seedPatternBlock(dirs.work, 'workday', '09:00', '18:00');
    seedPatternBlock(dirs.home, 'workday', '07:00', '08:00');
    seedPatternBlock(dirs.home, 'workday', '18:00', '23:00');
    seedPatternBlock(dirs.home, 'weekend', '08:00', '23:00');

    const r = await api(srv.url, '/api/pattern-blocks');
    expect(r.status).toBe(200);
    expect(r.body.workday[dirs.work]).toHaveLength(1);
    expect(r.body.workday[dirs.work][0]).toMatchObject({ start_time: '09:00', end_time: '18:00' });
    expect(r.body.workday[dirs.home]).toHaveLength(2);
    expect(r.body.weekend[dirs.home]).toHaveLength(1);
    expect(r.body.weekend[dirs.work]).toBeUndefined();
  });

  it('returns empty objects when no pattern_blocks exist', async () => {
    const r = await api(srv.url, '/api/pattern-blocks');
    expect(r.status).toBe(200);
    expect(r.body.workday).toEqual({});
    expect(r.body.weekend).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/pattern-blocks/:dirTagId/:dayType', () => {
  it('replaces ranges atomically; second identical call is idempotent', async () => {
    const dirs = seedDirections();
    const ranges = [{ start_time: '09:00', end_time: '12:00' }, { start_time: '14:00', end_time: '18:00' }];

    const r1 = await api(srv.url, `/api/pattern-blocks/${dirs.work}/workday`, {
      method: 'PUT', json: { ranges },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.ranges).toHaveLength(2);

    // Second call with same payload keeps the count at 2 (no duplicates)
    const r2 = await api(srv.url, `/api/pattern-blocks/${dirs.work}/workday`, {
      method: 'PUT', json: { ranges },
    });
    expect(r2.status).toBe(200);
    expect(r2.body.ranges).toHaveLength(2);
    const dbCount = (sqlite.prepare(`SELECT COUNT(*) c FROM pattern_blocks WHERE direction_tag_id = ?`).get(dirs.work) as { c: number }).c;
    expect(dbCount).toBe(2);
  });

  it('empty array clears all ranges for that direction+dayType', async () => {
    const dirs = seedDirections();
    seedPatternBlock(dirs.work, 'workday', '09:00', '18:00');

    const r = await api(srv.url, `/api/pattern-blocks/${dirs.work}/workday`, {
      method: 'PUT', json: { ranges: [] },
    });
    expect(r.status).toBe(200);
    expect(r.body.ranges).toHaveLength(0);
    const count = (sqlite.prepare(`SELECT COUNT(*) c FROM pattern_blocks WHERE direction_tag_id = ?`).get(dirs.work) as { c: number }).c;
    expect(count).toBe(0);
  });

  it('404 for an unknown dirTagId', async () => {
    const r = await api(srv.url, '/api/pattern-blocks/does-not-exist/workday', {
      method: 'PUT', json: { ranges: [] },
    });
    expect(r.status).toBe(404);
  });

  it('422 when tag is not a direction', async () => {
    const intId = (sqlite.prepare(`INSERT INTO tags (id, name, kind) VALUES (uuid7(), 'focus', 'intention') RETURNING id`).get() as { id: string }).id;
    const r = await api(srv.url, `/api/pattern-blocks/${intId}/workday`, {
      method: 'PUT', json: { ranges: [] },
    });
    expect(r.status).toBe(422);
  });

  it('422 when day_type is invalid', async () => {
    const dirs = seedDirections();
    const r = await api(srv.url, `/api/pattern-blocks/${dirs.work}/weeknight`, {
      method: 'PUT', json: { ranges: [] },
    });
    expect(r.status).toBe(422);
  });

  it('422 when end_time <= start_time', async () => {
    const dirs = seedDirections();
    const r = await api(srv.url, `/api/pattern-blocks/${dirs.work}/workday`, {
      method: 'PUT', json: { ranges: [{ start_time: '18:00', end_time: '09:00' }] },
    });
    expect(r.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ON DELETE CASCADE', () => {
  it('deleting a direction tag removes its pattern_blocks', async () => {
    const dirs = seedDirections();
    seedPatternBlock(dirs.work, 'workday', '09:00', '18:00');

    expect((sqlite.prepare(`SELECT COUNT(*) c FROM pattern_blocks WHERE direction_tag_id = ?`).get(dirs.work) as { c: number }).c).toBe(1);
    sqlite.prepare(`DELETE FROM tags WHERE id = ?`).run(dirs.work);
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM pattern_blocks WHERE direction_tag_id = ?`).get(dirs.work) as { c: number }).c).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('direction-aware Auto placement', () => {
  it('work-tagged task lands inside the Work window (09:00–18:00 UTC)', async () => {
    const dirs = seedDirections();
    seedPatternBlock(dirs.work, 'workday', '09:00', '18:00');

    const t = insertTask('Write code', 60, dirs.work);
    stageTask(t);

    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: WEEKDAY } });
    expect(r.body.result.step).toBe('place');
    expect(r.body.result.blocksCreated).toBeGreaterThanOrEqual(1);

    const blocks = placedBlocks();
    const wb = blocks.find((b) => b.title === 'Write code')!;
    expect(wb).toBeTruthy();
    expect(wb.start_at >= `${WEEKDAY}T09:00:00.000Z`).toBe(true);
    expect(wb.end_at <= `${WEEKDAY}T18:00:00.000Z`).toBe(true);
  });

  it('home-tagged task lands inside a Home window (07:00–08:00 or 18:00–23:00 UTC)', async () => {
    const dirs = seedDirections();
    seedPatternBlock(dirs.home, 'workday', '07:00', '08:00');
    seedPatternBlock(dirs.home, 'workday', '18:00', '23:00');

    const t = insertTask('Morning stretch', 30, dirs.home);
    stageTask(t);

    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: WEEKDAY } });
    expect(r.body.result.blocksCreated).toBeGreaterThanOrEqual(1);

    const wb = placedBlocks().find((b) => b.title === 'Morning stretch')!;
    expect(wb).toBeTruthy();
    const inMorning = wb.start_at >= `${WEEKDAY}T07:00:00.000Z` && wb.end_at <= `${WEEKDAY}T08:00:00.000Z`;
    const inEvening = wb.start_at >= `${WEEKDAY}T18:00:00.000Z` && wb.end_at <= `${WEEKDAY}T23:00:00.000Z`;
    expect(inMorning || inEvening).toBe(true);
  });

  it('direction-less task falls back to workday_start/end when direction windows exist', async () => {
    const dirs = seedDirections();
    // home has an early window; the direction-less task should ignore it and use 09:00–18:00
    seedPatternBlock(dirs.home, 'workday', '07:00', '08:00');
    sqlite.prepare(`UPDATE scheduling_prefs SET workday_start='09:00', workday_end='18:00' WHERE owner_id=?`).run(OWNER);

    const t = insertTask('Untagged work', 30); // no direction tag
    stageTask(t);

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: WEEKDAY } });

    const wb = placedBlocks().find((b) => b.title === 'Untagged work')!;
    expect(wb).toBeTruthy();
    expect(wb.start_at >= `${WEEKDAY}T09:00:00.000Z`).toBe(true);
    expect(wb.end_at <= `${WEEKDAY}T18:00:00.000Z`).toBe(true);
  });

  it('no pattern_blocks → classic workday window (backward-compatible)', async () => {
    // pattern_blocks table is empty (resetDb cascades tag deletes)
    sqlite.prepare(`UPDATE scheduling_prefs SET workday_start='10:00', workday_end='16:00' WHERE owner_id=?`).run(OWNER);

    const t = insertTask('Classic task', 30);
    stageTask(t);

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: WEEKDAY } });

    const wb = placedBlocks().find((b) => b.title === 'Classic task')!;
    expect(wb).toBeTruthy();
    expect(wb.start_at >= `${WEEKDAY}T10:00:00.000Z`).toBe(true);
    expect(wb.end_at <= `${WEEKDAY}T16:00:00.000Z`).toBe(true);
  });

  it('weekend date uses the weekend pattern windows', async () => {
    const dirs = seedDirections();
    // workday work=09-18; weekend work=10-12
    seedPatternBlock(dirs.work, 'workday', '09:00', '18:00');
    seedPatternBlock(dirs.work, 'weekend', '10:00', '12:00');

    const t = insertTask('Weekend task', 30, dirs.work);
    stageTask(t);

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: WEEKEND } });

    const wb = placedBlocks().find((b) => b.title === 'Weekend task')!;
    expect(wb).toBeTruthy();
    // Must be inside the WEEKEND window (10:00–12:00), not the wider workday window
    expect(wb.start_at >= `${WEEKEND}T10:00:00.000Z`).toBe(true);
    expect(wb.end_at <= `${WEEKEND}T12:00:00.000Z`).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2a per-pattern auto_fill gating (pattern_prefs / migration 0039+). A
// direction-tagged task is only placed into a pattern's windows when that
// pattern's auto_fill is true; a missing pref row defaults to true (legacy).
describe('per-pattern auto_fill gating', () => {
  it('gates per direction: Home(auto_fill=true) places, Work(auto_fill=false) does not', async () => {
    const dirs = seedDirections();
    seedPatternBlock(dirs.home, 'workday', '07:00', '08:00');
    seedPatternBlock(dirs.work, 'workday', '09:00', '18:00');
    seedPatternPref(dirs.home, true);
    seedPatternPref(dirs.work, false);

    const home = insertTask('Home chore', 30, dirs.home);
    const work = insertTask('Work task', 30, dirs.work);
    stageTask(home);
    stageTask(work);

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: WEEKDAY } });

    const blocks = placedBlocks();
    const hb = blocks.find((b) => b.title === 'Home chore');
    expect(hb).toBeTruthy();
    expect(hb!.start_at >= `${WEEKDAY}T07:00:00.000Z`).toBe(true);
    expect(hb!.end_at <= `${WEEKDAY}T08:00:00.000Z`).toBe(true);

    // Work pattern is gated off → its task is never placed (and never spills into
    // the workday fallback: it carries a direction tag, so Pass 2b skips it).
    expect(blocks.find((b) => b.title === 'Work task')).toBeUndefined();
  });

  it('untagged fallback is unaffected: all patterns auto_fill=false, untagged task still fills the workday', async () => {
    const dirs = seedDirections();
    // Pattern windows exist (so Pass 2 takes the direction-aware branch), but every
    // pattern is gated off. Global auto_fill_workday stays 1 (resetDb baseline).
    seedPatternBlock(dirs.home, 'workday', '07:00', '08:00');
    seedPatternBlock(dirs.work, 'workday', '09:00', '18:00');
    seedPatternPref(dirs.home, false);
    seedPatternPref(dirs.work, false);

    const t = insertTask('Untagged task', 30); // no direction tag
    stageTask(t);

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: WEEKDAY } });

    const wb = placedBlocks().find((b) => b.title === 'Untagged task');
    expect(wb).toBeTruthy();
    // Lands in the classic workday window (09:00–18:00), via Pass 2b.
    expect(wb!.start_at >= `${WEEKDAY}T09:00:00.000Z`).toBe(true);
    expect(wb!.end_at <= `${WEEKDAY}T18:00:00.000Z`).toBe(true);
  });

  it('defaults are legacy: with NO pattern_prefs rows, a home-tagged task still lands in a Home window', async () => {
    const dirs = seedDirections();
    seedPatternBlock(dirs.home, 'workday', '07:00', '08:00');
    seedPatternBlock(dirs.home, 'workday', '18:00', '23:00');
    // Intentionally NO pattern_prefs rows → missing pref defaults to auto_fill=true.

    const t = insertTask('Morning stretch', 30, dirs.home);
    stageTask(t);

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: WEEKDAY } });

    const wb = placedBlocks().find((b) => b.title === 'Morning stretch');
    expect(wb).toBeTruthy();
    const inMorning = wb!.start_at >= `${WEEKDAY}T07:00:00.000Z` && wb!.end_at <= `${WEEKDAY}T08:00:00.000Z`;
    const inEvening = wb!.start_at >= `${WEEKDAY}T18:00:00.000Z` && wb!.end_at <= `${WEEKDAY}T23:00:00.000Z`;
    expect(inMorning || inEvening).toBe(true);
  });
});
