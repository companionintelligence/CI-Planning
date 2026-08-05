import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  addDependency,
  setDependencies,
  getDependencies,
  blockedTaskIds,
  DependencyCycleError,
} from '../src/engine/deps.js';
import { resetDb, startTestServer, api } from './helpers.js';

function addTask(title: string): string {
  return (
    sqlite.prepare("INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), ?, ?, 'open') RETURNING id").get(title, SYSTEM_OWNER) as {
      id: string;
    }
  ).id;
}

describe('task dependencies', () => {
  beforeEach(() => resetDb());

  // These now assert on a REJECTED promise, not a synchronous throw: addDependency and
  // setDependencies are async, so `expect(() => …).toThrow()` would pass vacuously (the
  // call returns a promise rather than throwing) and the cycle guard would go untested.
  it('rejects self-edges and cycles', async () => {
    const a = addTask('A');
    const b = addTask('B');
    const c = addTask('C');

    await expect(addDependency(a, a)).rejects.toThrow(DependencyCycleError);

    await addDependency(a, b); // A depends on B
    await addDependency(b, c); // B depends on C
    await expect(addDependency(c, a)).rejects.toThrow(DependencyCycleError); // would close A→B→C→A
    expect(await getDependencies(a)).toEqual([b]);
  });

  it('blockedTaskIds reflects only incomplete blockers', async () => {
    const a = addTask('A');
    const b = addTask('B');
    await addDependency(a, b);

    expect((await blockedTaskIds()).has(a)).toBe(true);
    sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(b);
    expect((await blockedTaskIds()).has(a)).toBe(false);
  });

  it('cascade-deletes edges when a task is hard-deleted', async () => {
    const a = addTask('A');
    const b = addTask('B');
    await addDependency(a, b);

    sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(b);
    expect(await getDependencies(a)).toEqual([]);
  });

  it('setDependencies replaces the full blocker set', async () => {
    const a = addTask('A');
    const b = addTask('B');
    const c = addTask('C');
    await setDependencies(a, [b, c]);
    expect((await getDependencies(a)).sort()).toEqual([b, c].sort());
    await setDependencies(a, [b]);
    expect(await getDependencies(a)).toEqual([b]);
  });

  it('returns 409 when a PATCH would create a cycle', async () => {
    const srv = await startTestServer();
    try {
      const a = (await api<{ task: { id: string } }>(srv.url, '/api/tasks', { method: 'POST', json: { title: 'A' } })).body.task.id;
      const b = (await api<{ task: { id: string } }>(srv.url, '/api/tasks', { method: 'POST', json: { title: 'B' } })).body.task.id;

      const ok = await api(srv.url, `/api/tasks/${a}`, { method: 'PATCH', json: { depends_on: [b] } });
      expect(ok.status).toBe(200);

      const res = await api<{ error: string }>(srv.url, `/api/tasks/${b}`, { method: 'PATCH', json: { depends_on: [a] } });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('dependency cycle');
    } finally {
      await srv.close();
    }
  });

  it('owner-scoping a huge depends_on list chunks the IN-query (no bound-param overflow)', async () => {
    const a = addTask('A');
    // >SQLITE_MAX_VARIABLE_NUMBER worth of ids: a single IN(?, …) would throw.
    const many = Array.from({ length: 1500 }, (_, i) => `nonexistent-${i}`);
    await expect(setDependencies(a, many, SYSTEM_OWNER)).resolves.toBeUndefined();
    // None are owner-owned tasks, so all are dropped — no edges created.
    expect(await getDependencies(a)).toEqual([]);
  });
});
