import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Pattern model (Phase G, G1): pattern types (built-in + custom) and patterns
 * (typed, many-to-many task collections) with their REST surface.
 */

const OWNER = SYSTEM_OWNER;

const insertTask = (title: string): string =>
  (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), ?, ?, 'open') RETURNING id`).get(title, OWNER) as { id: string }).id;
const taskExists = (id: string) => !!sqlite.prepare(`SELECT id FROM tasks WHERE id = ?`).get(id);
const memberCount = (pid: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM pattern_tasks WHERE pattern_id = ?`).get(pid) as { c: number }).c;
const typeByName = (name: string): { id: string } =>
  sqlite.prepare(`SELECT id FROM pattern_types WHERE name = ? AND owner_id = ?`).get(name, OWNER) as { id: string };

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

beforeEach(() => {
  resetDb(); // doesn't touch pattern tables — clear them, keep the seeded built-ins
  sqlite.exec(`DELETE FROM pattern_tasks; DELETE FROM patterns; DELETE FROM pattern_types WHERE is_builtin = 0;`);
});

describe('pattern types', () => {
  it('seeds four built-in types; Ritual is hidden by default (PR-C+: enable_rituals flag)', async () => {
    // Default: enable_rituals=false (0024 migration), so the listing route filters Ritual out.
    // Community (catch-all), Habit, and Routine are visible by default.
    const { status, body } = await api(srv.url, '/api/pattern-types');
    expect(status).toBe(200);
    const names = body.pattern_types.map((t: any) => t.name).sort();
    expect(names).toEqual(['Community', 'Habit', 'Routine']);
    const byName = Object.fromEntries(body.pattern_types.map((t: any) => [t.name, t]));
    expect(byName.Routine.icon_shape).toBe('square');
    expect(byName.Habit.icon_shape).toBe('circle');
    expect(byName.Habit.is_builtin).toBe(true);

    // The Ritual row still exists in the DB — flipping the flag on restores it
    // (no migration required, just a PATCH /api/prefs in the real client).
    expect((sqlite.prepare(`SELECT name FROM pattern_types WHERE name = 'Ritual' AND owner_id = ?`).get(OWNER) as { name: string }).name).toBe('Ritual');

    sqlite.prepare(`UPDATE scheduling_prefs SET enable_rituals = 1 WHERE owner_id = ?`).run(OWNER);
    const after = await api(srv.url, '/api/pattern-types');
    const ritual = after.body.pattern_types.find((t: any) => t.name === 'Ritual');
    expect(ritual?.icon_shape).toBe('triangle');
    sqlite.prepare(`UPDATE scheduling_prefs SET enable_rituals = 0 WHERE owner_id = ?`).run(OWNER); // reset for sibling tests
  });

  it('creates a custom type (is_builtin false) and lists it', async () => {
    const c = await api(srv.url, '/api/pattern-types', { method: 'POST', json: { name: 'Errand-run', icon_shape: 'hexagon' } });
    expect(c.status).toBe(201);
    expect(c.body.pattern_type.is_builtin).toBe(false);
    const list = await api(srv.url, '/api/pattern-types');
    expect(list.body.pattern_types.map((t: any) => t.name)).toContain('Errand-run');
  });

  it('rejects missing name/icon (422) and a duplicate name (422)', async () => {
    expect((await api(srv.url, '/api/pattern-types', { method: 'POST', json: { name: 'x' } })).status).toBe(422);
    await api(srv.url, '/api/pattern-types', { method: 'POST', json: { name: 'Dup', icon_shape: 'square' } });
    expect((await api(srv.url, '/api/pattern-types', { method: 'POST', json: { name: 'Dup', icon_shape: 'circle' } })).status).toBe(422);
  });

  it('refuses to delete a built-in (400), a type in use (409); deletes an unused custom (200)', async () => {
    const habit = typeByName('Habit');
    expect((await api(srv.url, `/api/pattern-types/${habit.id}`, { method: 'DELETE' })).status).toBe(400);

    const inUse = (await api(srv.url, '/api/pattern-types', { method: 'POST', json: { name: 'Temp', icon_shape: 'square' } })).body.pattern_type;
    await api(srv.url, '/api/patterns', { method: 'POST', json: { type_id: inUse.id, name: 'P' } });
    expect((await api(srv.url, `/api/pattern-types/${inUse.id}`, { method: 'DELETE' })).status).toBe(409);

    const unused = (await api(srv.url, '/api/pattern-types', { method: 'POST', json: { name: 'Temp2', icon_shape: 'square' } })).body.pattern_type;
    expect((await api(srv.url, `/api/pattern-types/${unused.id}`, { method: 'DELETE' })).status).toBe(200);
  });
});

describe('patterns + membership', () => {
  it('creates a pattern with member tasks; returns type_id + ordered task_ids', async () => {
    const a = insertTask('check ingredients');
    const b = insertTask('grocery shopping');
    const ritual = typeByName('Ritual');
    const c = await api(srv.url, '/api/patterns', {
      method: 'POST',
      json: { type_id: ritual.id, name: 'Family dinner', tag: 'family', task_ids: [a, b] },
    });
    expect(c.status).toBe(201);
    expect(c.body.pattern.type_id).toBe(ritual.id);
    expect(c.body.pattern.task_ids).toEqual([a, b]);
    // AF-11: an incoming `tag` is accepted for API compat but IGNORED — routines
    // author no tags (directions/intentions derive from member tasks; see
    // routine-derived-tags.test.ts).
    expect(c.body.pattern.tag).toBeNull();
    expect(c.body.pattern.directions).toEqual([]);
    expect(c.body.pattern.intentions).toEqual([]);
  });

  it('a task can belong to two patterns (many-to-many)', async () => {
    const groc = insertTask('grocery shopping');
    const p1 = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Errands', tag: 'errands', task_ids: [groc] } })).body.pattern;
    const p2 = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Family dinner', tag: 'family', task_ids: [groc] } })).body.pattern;
    expect(p1.task_ids).toContain(groc);
    expect(p2.task_ids).toContain(groc);
  });

  it('deleting a pattern leaves its tasks intact', async () => {
    const t = insertTask('keep me');
    const p = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'P', task_ids: [t] } })).body.pattern;
    expect((await api(srv.url, `/api/patterns/${p.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(taskExists(t)).toBe(true);
    expect(memberCount(p.id)).toBe(0);
  });

  it('rejects an unknown type_id (422) and a missing name (422)', async () => {
    expect((await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'x', type_id: 999999 } })).status).toBe(422);
    expect((await api(srv.url, '/api/patterns', { method: 'POST', json: { type_id: typeByName('Habit').id } })).status).toBe(422);
  });

  it('add/remove membership endpoints update task_ids', async () => {
    const t1 = insertTask('t1');
    const t2 = insertTask('t2');
    const p = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'P', task_ids: [t1] } })).body.pattern;
    const add = await api(srv.url, `/api/patterns/${p.id}/tasks`, { method: 'POST', json: { task_id: t2 } });
    expect([...add.body.task_ids].sort()).toEqual([t1, t2].sort());
    const rm = await api(srv.url, `/api/patterns/${p.id}/tasks/${t1}`, { method: 'DELETE' });
    expect(rm.body.task_ids).toEqual([t2]);
  });

  it('PATCH replaces fields + membership', async () => {
    const t1 = insertTask('t1');
    const t2 = insertTask('t2');
    const p = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Old', task_ids: [t1] } })).body.pattern;
    const u = await api(srv.url, `/api/patterns/${p.id}`, { method: 'PATCH', json: { name: 'New', task_ids: [t2] } });
    expect(u.body.pattern.name).toBe('New');
    expect(u.body.pattern.task_ids).toEqual([t2]);
  });
});
