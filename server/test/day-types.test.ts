import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { resolveDayType } from '../src/services/day-types.js';
import { newId } from '../src/lib/ids.js';

/**
 * Day types (T-SCHED-3): the resolver (assignment > week-map > UTC weekend
 * heuristic), the catalog/map/assignment API, that the pattern_blocks CHECK was
 * dropped (custom keys storable), and that a per-date assignment drives placement.
 *
 * UTC-pinned dates (helpers force timezone='UTC'):
 *   2026-06-22 = Monday (workday)   2026-06-21 = Sunday (weekend)
 */
const OWNER = SYSTEM_OWNER;
const MON = '2026-06-22';
const SUN = '2026-06-21';
const SAT = '2026-06-20';

function seedDirections(): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const name of ['home', 'work', 'community']) {
    ids[name] = (
      sqlite.prepare(`INSERT INTO tags (id, name, kind, is_base) VALUES (uuid7(), ?, 'pattern', 1) RETURNING id`).get(name) as { id: string }
    ).id;
  }
  return ids;
}
function seedPatternBlock(dirTagId: string, dayType: string, start: string, end: string): void {
  sqlite
    .prepare(`INSERT INTO pattern_blocks (id, owner_id, pattern_tag_id, day_type, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(newId(), OWNER, dirTagId, dayType, start, end);
}
function insertTask(title: string, est: number, dirTagId?: string): string {
  const id = (
    sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`).get(title, OWNER, est) as { id: string }
  ).id;
  if (dirTagId) sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, dirTagId);
  return id;
}
function stageTask(taskId: string): void {
  sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
}
const placedBlocks = () =>
  sqlite.prepare(`SELECT title, start_at, end_at FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1 ORDER BY start_at`).all() as {
    title: string; start_at: string; end_at: string;
  }[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb(); // clears day_assignments + day_of_week_map (overrides); builtins persist
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM day_types WHERE is_builtin = 0;`);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveDayType — behavior preservation (no overrides)', () => {
  it('matches the legacy isWeekendDate split with no map/assignment rows', () => {
    expect(resolveDayType(OWNER, MON)).toBe('workday');
    expect(resolveDayType(OWNER, SUN)).toBe('weekend');
    expect(resolveDayType(OWNER, SAT)).toBe('weekend');
  });
});

describe('resolveDayType — precedence', () => {
  it('per-date assignment beats the weekly map and the heuristic', async () => {
    await api(srv.url, `/api/day-types/assignments/${MON}`, { method: 'PUT', json: { day_type_key: 'weekend' } });
    expect(resolveDayType(OWNER, MON)).toBe('weekend');
    await api(srv.url, `/api/day-types/assignments/${MON}`, { method: 'DELETE' });
    expect(resolveDayType(OWNER, MON)).toBe('workday'); // back to default
  });

  it('the weekly map overrides the heuristic when no assignment', async () => {
    // Monday (dow 1) → weekend via the map.
    await api(srv.url, '/api/day-types/week-map', { method: 'PUT', json: { map: { 1: 'weekend' } } });
    expect(resolveDayType(OWNER, MON)).toBe('weekend');
    expect(resolveDayType(OWNER, '2026-06-23')).toBe('workday'); // Tuesday unaffected
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pattern_blocks CHECK was dropped (custom keys storable)', () => {
  it('accepts a pattern_blocks row with a custom day_type', () => {
    const dirs = seedDirections();
    expect(() => seedPatternBlock(dirs.work, 'holiday', '10:00', '14:00')).not.toThrow();
    const n = (sqlite.prepare(`SELECT COUNT(*) c FROM pattern_blocks WHERE day_type = 'holiday'`).get() as { c: number }).c;
    expect(n).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/day-types', () => {
  it('returns the seeded builtins', async () => {
    const r = await api(srv.url, '/api/day-types');
    expect(r.status).toBe(200);
    const keys = (r.body.day_types as { key: string; is_builtin: boolean }[]).map((d) => d.key);
    expect(keys).toContain('workday');
    expect(keys).toContain('weekend');
    expect((r.body.day_types as { key: string; is_builtin: boolean }[]).find((d) => d.key === 'workday')!.is_builtin).toBe(true);
  });
});

describe('day-type catalog CRUD', () => {
  it('creates a custom type, rejects duplicates and bad keys', async () => {
    const c = await api(srv.url, '/api/day-types', { method: 'POST', json: { key: 'holiday', name: 'Holiday' } });
    expect(c.status).toBe(201);
    expect(c.body.day_type).toMatchObject({ key: 'holiday', name: 'Holiday', is_builtin: false });

    const dup = await api(srv.url, '/api/day-types', { method: 'POST', json: { key: 'holiday', name: 'Holiday 2' } });
    expect(dup.status).toBe(409);

    const bad = await api(srv.url, '/api/day-types', { method: 'POST', json: { key: 'Has Spaces', name: 'x' } });
    expect(bad.status).toBe(422);
  });

  it('renames any type but only deletes custom ones', async () => {
    const c = await api(srv.url, '/api/day-types', { method: 'POST', json: { key: 'holiday', name: 'Holiday' } });
    const id = c.body.day_type.id as string;

    const rn = await api(srv.url, `/api/day-types/${id}`, { method: 'PATCH', json: { name: 'Day Off' } });
    expect(rn.status).toBe(200);
    expect(rn.body.day_type.name).toBe('Day Off');

    // Builtins are rename-only — delete must be refused.
    const list = await api(srv.url, '/api/day-types');
    const workday = (list.body.day_types as { id: string; key: string }[]).find((d) => d.key === 'workday')!;
    const delBuiltin = await api(srv.url, `/api/day-types/${workday.id}`, { method: 'DELETE' });
    expect(delBuiltin.status).toBe(422);

    const delCustom = await api(srv.url, `/api/day-types/${id}`, { method: 'DELETE' });
    expect(delCustom.status).toBe(200);
  });
});

describe('week-map + assignments API', () => {
  it('GET week-map returns a full 7-day default; PUT round-trips and validates keys', async () => {
    const g = await api(srv.url, '/api/day-types/week-map');
    expect(Object.keys(g.body.map)).toHaveLength(7);
    expect(g.body.map['1']).toBe('workday'); // Monday
    expect(g.body.map['0']).toBe('weekend'); // Sunday

    const put = await api(srv.url, '/api/day-types/week-map', { method: 'PUT', json: { map: { 1: 'weekend' } } });
    expect(put.status).toBe(200);
    expect(put.body.map['1']).toBe('weekend');

    const bad = await api(srv.url, '/api/day-types/week-map', { method: 'PUT', json: { map: { 1: 'nope' } } });
    expect(bad.status).toBe(422);
  });

  it('assignment PUT/GET/DELETE round-trip; unknown key + bad date are 422', async () => {
    const put = await api(srv.url, `/api/day-types/assignments/${MON}`, { method: 'PUT', json: { day_type_key: 'weekend' } });
    expect(put.status).toBe(200);

    const get = await api(srv.url, '/api/day-types/assignments');
    expect(get.body.assignments[MON]).toBe('weekend');

    expect((await api(srv.url, `/api/day-types/assignments/${MON}`, { method: 'PUT', json: { day_type_key: 'nope' } })).status).toBe(422);
    expect((await api(srv.url, '/api/day-types/assignments/2026-13-99', { method: 'PUT', json: { day_type_key: 'weekend' } })).status).toBe(422);

    const del = await api(srv.url, `/api/day-types/assignments/${MON}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await api(srv.url, '/api/day-types/assignments')).body.assignments[MON]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('per-date assignment drives Auto placement', () => {
  it('a Monday assigned to "weekend" places into the weekend window, not the workday one', async () => {
    const dirs = seedDirections();
    seedPatternBlock(dirs.work, 'workday', '09:00', '18:00');
    seedPatternBlock(dirs.work, 'weekend', '10:00', '12:00');

    // Override Monday → weekend.
    await api(srv.url, `/api/day-types/assignments/${MON}`, { method: 'PUT', json: { day_type_key: 'weekend' } });

    const t = insertTask('Assigned task', 30, dirs.work);
    stageTask(t);
    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: MON } });

    const wb = placedBlocks().find((b) => b.title === 'Assigned task')!;
    expect(wb).toBeTruthy();
    // Inside the WEEKEND window (10:00–12:00), proving the assignment flipped the day type.
    expect(wb.start_at >= `${MON}T10:00:00.000Z`).toBe(true);
    expect(wb.end_at <= `${MON}T12:00:00.000Z`).toBe(true);
  });
});
