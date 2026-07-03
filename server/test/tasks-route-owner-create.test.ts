import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createOwner, resetDb, startTestServer, api, SECOND_OWNER_ID, type TestServer } from './helpers.js';

/**
 * Multi-tenant WRITE-side isolation for POST/PATCH /api/tasks (IDOR regression,
 * W3.1b — completes the owner-scoping hardening after #244 mutators + #245 reads).
 *
 * Three exploit-verified holes, all driven AS owner B via `x-test-owner` (owner
 * A == SYSTEM_OWNER):
 *   1. `depends_on` accepted ANOTHER owner's task id (cross-owner completion oracle
 *      + id-existence disclosure through the returned `blocked` flag).
 *   2. A client-supplied body `owner_id` overrode the authenticated caller (task
 *      injection into another tenant).
 *   3. `parent_id` could point at a FOREIGN task (dangling cross-tenant ref).
 */

describe('tasks routes — cross-owner create/update isolation (W3.1b)', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { resetDb(); createOwner(); }); // SYSTEM_OWNER (A) + Owner B (SECOND_OWNER_ID)

  const asB = { headers: { 'x-test-owner': SECOND_OWNER_ID } };

  async function createTaskAs(owner: 'A' | 'B', json: Record<string, unknown>): Promise<any> {
    const init = { method: 'POST', json, ...(owner === 'B' ? asB : {}) };
    return api(srv.url, '/api/tasks', init);
  }

  it("owner A cannot CREATE a task depending on owner B's task (foreign id dropped, not blocked)", async () => {
    const bId = (await createTaskAs('B', { title: 'B blocker' })).body.task.id as string;

    const r = await createTaskAs('A', { title: 'A dependent', depends_on: [bId] });
    expect(r.status).toBe(201);
    // The foreign blocker id is silently dropped — no cross-owner edge, no existence leak.
    expect(r.body.task.depends_on).toEqual([]);
    expect(r.body.task.blocked).toBe(false);
    // And no edge landed in task_dependencies at all.
    const edges = sqlite
      .prepare('SELECT depends_on_id AS d FROM task_dependencies WHERE task_id = ?')
      .all(r.body.task.id) as { d: string }[];
    expect(edges).toEqual([]);
  });

  it("owner A cannot UPDATE a task to depend on owner B's task", async () => {
    const bId = (await createTaskAs('B', { title: 'B blocker' })).body.task.id as string;
    const aId = (await createTaskAs('A', { title: 'A dependent' })).body.task.id as string;

    const r = await api(srv.url, `/api/tasks/${aId}`, { method: 'PATCH', json: { depends_on: [bId] } });
    expect(r.status).toBe(200);
    expect(r.body.task.depends_on).toEqual([]);
    expect(r.body.task.blocked).toBe(false);
  });

  it('an owner-owned depends_on id is still accepted (fix does not over-drop)', async () => {
    const blocker = (await createTaskAs('A', { title: 'A blocker' })).body.task.id as string;
    const r = await createTaskAs('A', { title: 'A dependent', depends_on: [blocker] });
    expect(r.status).toBe(201);
    expect(r.body.task.depends_on).toEqual([blocker]);
    expect(r.body.task.blocked).toBe(true); // blocker is open → dependent is blocked
  });

  it('owner A cannot inject a task into owner B via a body owner_id (persisted owner is A)', async () => {
    const r = await createTaskAs('A', { title: 'planted', owner_id: SECOND_OWNER_ID } as Record<string, unknown>);
    expect(r.status).toBe(201);
    const row = sqlite.prepare('SELECT owner_id FROM tasks WHERE id = ?').get(r.body.task.id) as { owner_id: string };
    expect(row.owner_id).toBe(SYSTEM_OWNER); // owner A, never B
    expect(row.owner_id).not.toBe(SECOND_OWNER_ID);
  });

  it('a recurring create also ignores a body owner_id', async () => {
    const r = await createTaskAs('A', { title: 'planted series', recurrence_rule: 'FREQ=DAILY', owner_id: SECOND_OWNER_ID } as Record<string, unknown>);
    expect(r.status).toBe(201);
    const row = sqlite.prepare('SELECT owner_id FROM tasks WHERE id = ?').get(r.body.task.id) as { owner_id: string };
    expect(row.owner_id).not.toBe(SECOND_OWNER_ID);
  });

  it("owner A cannot set parent_id to owner B's task on CREATE (dropped to null)", async () => {
    const bParent = (await createTaskAs('B', { title: 'B parent' })).body.task.id as string;
    const r = await createTaskAs('A', { title: 'A child', parent_id: bParent });
    expect(r.status).toBe(201);
    const row = sqlite.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(r.body.task.id) as { parent_id: string | null };
    expect(row.parent_id).toBeNull();
  });

  it("owner A cannot set parent_id to owner B's task on UPDATE (dropped to null)", async () => {
    const bParent = (await createTaskAs('B', { title: 'B parent' })).body.task.id as string;
    const aId = (await createTaskAs('A', { title: 'A child' })).body.task.id as string;

    const r = await api(srv.url, `/api/tasks/${aId}`, { method: 'PATCH', json: { parent_id: bParent } });
    expect(r.status).toBe(200);
    const row = sqlite.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(aId) as { parent_id: string | null };
    expect(row.parent_id).toBeNull();
  });

  it('an owner-owned parent_id is still accepted (fix does not over-drop)', async () => {
    const aParent = (await createTaskAs('A', { title: 'A parent' })).body.task.id as string;
    const r = await createTaskAs('A', { title: 'A child', parent_id: aParent });
    expect(r.status).toBe(201);
    const row = sqlite.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(r.body.task.id) as { parent_id: string | null };
    expect(row.parent_id).toBe(aParent);
  });
});
