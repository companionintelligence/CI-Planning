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

  it('rejects self-edges and cycles', () => {
    const a = addTask('A');
    const b = addTask('B');
    const c = addTask('C');

    expect(() => addDependency(a, a)).toThrow(DependencyCycleError);

    addDependency(a, b); // A depends on B
    addDependency(b, c); // B depends on C
    expect(() => addDependency(c, a)).toThrow(DependencyCycleError); // would close A→B→C→A
    expect(getDependencies(a)).toEqual([b]);
  });

  it('blockedTaskIds reflects only incomplete blockers', () => {
    const a = addTask('A');
    const b = addTask('B');
    addDependency(a, b);

    expect(blockedTaskIds().has(a)).toBe(true);
    sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(b);
    expect(blockedTaskIds().has(a)).toBe(false);
  });

  it('cascade-deletes edges when a task is hard-deleted', () => {
    const a = addTask('A');
    const b = addTask('B');
    addDependency(a, b);

    sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(b);
    expect(getDependencies(a)).toEqual([]);
  });

  it('setDependencies replaces the full blocker set', () => {
    const a = addTask('A');
    const b = addTask('B');
    const c = addTask('C');
    setDependencies(a, [b, c]);
    expect(getDependencies(a).sort()).toEqual([b, c].sort());
    setDependencies(a, [b]);
    expect(getDependencies(a)).toEqual([b]);
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

  it('owner-scoping a huge depends_on list chunks the IN-query (no bound-param overflow)', () => {
    const a = addTask('A');
    // >SQLITE_MAX_VARIABLE_NUMBER worth of ids: a single IN(?, …) would throw.
    const many = Array.from({ length: 1500 }, (_, i) => `nonexistent-${i}`);
    expect(() => setDependencies(a, many, SYSTEM_OWNER)).not.toThrow();
    // None are owner-owned tasks, so all are dropped — no edges created.
    expect(getDependencies(a)).toEqual([]);
  });
});
