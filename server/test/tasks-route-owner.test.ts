import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { createOwner, resetDb, startTestServer, api, SECOND_OWNER_ID, type TestServer } from './helpers.js';

/**
 * Multi-tenant read-side isolation for the tasks routes (IDOR regression).
 *
 * `GET /api/tasks` used to run an unscoped `db.select()` when no `owner_id` param
 * was passed, returning EVERY owner's tasks — a cross-tenant read leak, separate
 * from the W3.1a mutator fix. These lock the fix on the three read endpoints:
 * the list, `/:id/subtasks`, and `/:id/streak`. Driven AS owner B via the
 * test-only `x-test-owner` header (owner A == SYSTEM_OWNER).
 */

describe('tasks routes — cross-owner read isolation', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { resetDb(); createOwner(); }); // SYSTEM_OWNER + Owner B (SECOND_OWNER_ID)

  const asB = { headers: { 'x-test-owner': SECOND_OWNER_ID } };

  async function createTaskAs(owner: 'A' | 'B', title: string): Promise<string> {
    const init = { method: 'POST', json: { title }, ...(owner === 'B' ? asB : {}) };
    const r = await api(srv.url, '/api/tasks', init);
    expect(r.status).toBe(201);
    return r.body.task.id as string;
  }

  it('owner A never sees owner B tasks in the list, and vice versa', async () => {
    const aId = await createTaskAs('A', 'A private');
    const bId = await createTaskAs('B', 'B private');

    const aList = await api(srv.url, '/api/tasks'); // as SYSTEM (A)
    const aIds = (aList.body.tasks as { id: string }[]).map((t) => t.id);
    expect(aIds).toContain(aId);
    expect(aIds).not.toContain(bId);

    const bList = await api(srv.url, '/api/tasks', asB);
    const bIds = (bList.body.tasks as { id: string }[]).map((t) => t.id);
    expect(bIds).toContain(bId);
    expect(bIds).not.toContain(aId);
  });

  it("an explicit owner_id param cannot widen past the caller", async () => {
    const bId = await createTaskAs('B', 'B private');
    // Owner A tries to widen to owner B's data via the param — must not leak.
    const r = await api(srv.url, `/api/tasks?owner_id=${SECOND_OWNER_ID}`); // as SYSTEM (A)
    expect(r.status).toBe(200);
    expect((r.body.tasks as { id: string }[]).some((t) => t.id === bId)).toBe(false);
  });

  it('owner A cannot read owner B subtasks via a foreign parent id', async () => {
    const bParent = await createTaskAs('B', 'B parent');
    const bChild = await api(srv.url, '/api/tasks', { ...asB, method: 'POST', json: { title: 'B child', parent_id: bParent } });
    expect(bChild.status).toBe(201);

    const stolen = await api(srv.url, `/api/tasks/${bParent}/subtasks`); // as SYSTEM (A)
    expect(stolen.status).toBe(200);
    expect((stolen.body.subtasks as unknown[]).length).toBe(0);

    // The real owner still sees the subtree.
    const owned = await api(srv.url, `/api/tasks/${bParent}/subtasks`, asB);
    expect((owned.body.subtasks as { id: string }[]).map((t) => t.id)).toEqual([bChild.body.task.id]);
  });

  it("owner A gets 404 on owner B's streak; owner B gets it", async () => {
    const created = await api(srv.url, '/api/tasks', { ...asB, method: 'POST', json: { title: 'B habit', recurrence_rule: 'FREQ=DAILY' } });
    expect(created.status).toBe(201);
    const bTemplate = created.body.task.id as string;

    const stolen = await api(srv.url, `/api/tasks/${bTemplate}/streak`); // as SYSTEM (A)
    expect(stolen.status).toBe(404);
    // Indistinguishable from the "not recurring / absent" 404 — no existence probe.
    expect(stolen.body.error).toBe('not a recurring task');

    const owned = await api(srv.url, `/api/tasks/${bTemplate}/streak`, asB);
    expect(owned.status).toBe(200);
    expect(owned.body.templateId).toBe(bTemplate);
  });

  it('a directly-inserted foreign task is invisible to the list (no header needed)', async () => {
    // Belt-and-suspenders: even a task written straight to the DB under another
    // owner must never surface in the default (unparameterized) list read.
    const foreignId = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'Foreign', ?, 'open') RETURNING id`)
      .get(SECOND_OWNER_ID) as { id: string }).id;
    const list = await api(srv.url, '/api/tasks'); // as SYSTEM (A)
    expect((list.body.tasks as { id: string }[]).some((t) => t.id === foreignId)).toBe(false);
  });
});
