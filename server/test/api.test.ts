import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

describe('tasks / blocks / tags / possibles API', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  it('creates, lists, updates, completes and cancels a task', async () => {
    const created = await api(server.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Write the spec', priority: 2, estimated_minutes: 45, tags: ['eng', 'docs'] },
    });
    expect(created.status).toBe(201);
    const id = created.body.task.id;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const list = await api(server.url, '/api/tasks');
    expect(list.body.tasks.find((t: any) => t.id === id)?.tags).toEqual(expect.arrayContaining(['eng', 'docs']));

    const patched = await api(server.url, `/api/tasks/${id}`, { method: 'PATCH', json: { completed: true } });
    expect(patched.body.task.status).toBe('done');
    expect(patched.body.task.completedAt ?? patched.body.task.completed_at).toBeTruthy();

    const cancelled = await api(server.url, `/api/tasks/${id}`, { method: 'DELETE' });
    expect(cancelled.body.task.status).toBe('cancelled');
  });

  it('keeps subtype ⇄ is_habit/is_fast_task coherent across the legacy is_habit PATCH (CON-2c regression)', async () => {
    // A quick task: is_fast_task derives from the canonical subtype.
    const created = await api(server.url, '/api/tasks', { method: 'POST', json: { title: 'dash', subtype: 'quick' } });
    expect(created.body.task.subtype).toBe('quick');
    expect(created.body.task.is_fast_task).toBeTruthy();
    const id = created.body.task.id;

    // Flip to a habit via the LEGACY is_habit field. This path previously left
    // is_fast_task=1 — a habit that was also a fast task. It must now be cleared.
    const patched = await api(server.url, `/api/tasks/${id}`, { method: 'PATCH', json: { is_habit: true } });
    expect(patched.body.task.subtype).toBe('habit');
    expect(patched.body.task.is_habit).toBeTruthy();
    expect(patched.body.task.is_fast_task).toBeFalsy(); // the fix

    // Canonical subtype path clears both aliases symmetrically.
    const back = await api(server.url, `/api/tasks/${id}`, { method: 'PATCH', json: { subtype: 'standard' } });
    expect(back.body.task.subtype).toBe('standard');
    expect(back.body.task.is_habit).toBeFalsy();
    expect(back.body.task.is_fast_task).toBeFalsy();
  });

  it('recall clones a shelved task + its subtree to fresh open tasks (cockpit-v2 Phase 6)', async () => {
    const parent = await api(server.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Quarterly report', priority: 2, estimated_minutes: 90, notes: 'draft then review', tags: ['work'] },
    });
    const pid = parent.body.task.id;
    const sub = await api(server.url, '/api/tasks', { method: 'POST', json: { title: 'Gather numbers', parent_id: pid } });
    const subId = sub.body.task.id;
    await api(server.url, `/api/tasks/${pid}`, { method: 'PATCH', json: { completed: true } }); // shelve it

    const recalled = await api(server.url, `/api/tasks/${pid}/recall`, { method: 'POST', json: {} });
    expect(recalled.status).toBe(201);
    const clone = recalled.body.task;
    expect(clone.id).not.toBe(pid);                       // brand-new id
    expect(clone.status).toBe('open');                    // fresh, not done
    expect(clone.title).toBe('Quarterly report');
    expect(clone.estimated_minutes).toBe(90);
    expect(clone.notes).toBe('draft then review');
    expect(clone.tags).toEqual(expect.arrayContaining(['work']));
    expect(clone.parent_id ?? null).toBeNull();           // top clone is independent

    const kids = await api(server.url, `/api/tasks/${clone.id}/subtasks`);
    expect(kids.body.subtasks.length).toBe(1);            // subtree came along
    expect(kids.body.subtasks[0].id).not.toBe(subId);     // re-id'd
    expect(kids.body.subtasks[0].title).toBe('Gather numbers');
    expect(kids.body.subtasks[0].status).toBe('open');
  });

  it('rejects a task with no title', async () => {
    const res = await api(server.url, '/api/tasks', { method: 'POST', json: { priority: 1 } });
    expect(res.status).toBe(400);
  });

  it('filters tasks by status and tag', async () => {
    await api(server.url, '/api/tasks', { method: 'POST', json: { title: 'A', tags: ['work'] } });
    await api(server.url, '/api/tasks', { method: 'POST', json: { title: 'B', tags: ['home'] } });

    const work = await api(server.url, '/api/tasks?tag=work');
    expect(work.body.tasks.length).toBe(1);
    expect(work.body.tasks[0].title).toBe('A');

    const open = await api(server.url, '/api/tasks?status=open');
    expect(open.body.tasks.length).toBe(2);
  });

  it('creates and lists time blocks within a range', async () => {
    const block = await api(server.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Focus', block_kind: 'focus', start_at: '2026-06-01T16:00:00.000Z', end_at: '2026-06-01T17:00:00.000Z' },
    });
    expect(block.status).toBe(201);

    const inRange = await api(server.url, '/api/blocks?from=2026-06-01T00:00:00.000Z&to=2026-06-01T23:59:59.000Z');
    expect(inRange.body.blocks.length).toBe(1);

    const patched = await api(server.url, `/api/blocks/${block.body.block.id}`, { method: 'PATCH', json: { status: 'completed' } });
    expect(patched.body.block.status).toBe('completed');
  });

  it('drag/resize persists exact start/end instants via one PATCH (no tz drift)', async () => {
    // The grid PATCHes the instants `instantFor` produced; the server must echo
    // them byte-identically (no re-formatting that could introduce drift).
    const block = await api(server.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Move me', start_at: '2026-06-01T16:00:00.000Z', end_at: '2026-06-01T17:00:00.000Z' },
    });
    const id = block.body.block.id;
    // A +1h drag.
    const moved = await api(server.url, `/api/blocks/${id}`, {
      method: 'PATCH',
      json: { start_at: '2026-06-01T17:00:00.000Z', end_at: '2026-06-01T18:00:00.000Z' },
    });
    expect(moved.body.block.start_at).toBe('2026-06-01T17:00:00.000Z');
    expect(moved.body.block.end_at).toBe('2026-06-01T18:00:00.000Z');
    // Round-trips through GET unchanged.
    const got = await api(server.url, '/api/blocks?from=2026-06-01T00:00:00.000Z&to=2026-06-01T23:59:59.999Z');
    const row = got.body.blocks.find((b: any) => b.id === id);
    expect(row.start_at).toBe('2026-06-01T17:00:00.000Z');
    expect(row.end_at).toBe('2026-06-01T18:00:00.000Z');
  });

  it('all_day is in the create/PATCH allow-list and round-trips', async () => {
    const created = await api(server.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Conference', start_at: '2026-06-02T07:00:00.000Z', end_at: '2026-06-03T06:59:59.999Z', all_day: true },
    });
    expect(created.status).toBe(201);
    expect(created.body.block.all_day).toBe(true);

    // PATCH toggles it back off.
    const patched = await api(server.url, `/api/blocks/${created.body.block.id}`, {
      method: 'PATCH',
      json: { all_day: false },
    });
    expect(patched.body.block.all_day).toBe(false);
  });

  it('aggregates tag counts', async () => {
    await api(server.url, '/api/tasks', { method: 'POST', json: { title: 'T1', tags: ['alpha'] } });
    await api(server.url, '/api/tasks', { method: 'POST', json: { title: 'T2', tags: ['alpha', 'beta'] } });
    const tags = await api(server.url, '/api/tags');
    const alpha = tags.body.tags.find((t: any) => t.name === 'alpha');
    expect(alpha.count).toBe(2);
  });

  it('promotes and dismisses possible tasks', async () => {
    // Seed a couple of possibles directly through the DB-backed promote/dismiss endpoints.
    const { sqlite } = await import('../src/db/index.js');
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status)
         VALUES (uuid7(), 'Promote me', 'gmail', 'x#0', 0.9, 'pending'), (uuid7(), 'Dismiss me', 'gmail', 'y#0', 0.4, 'pending')`
      )
      .run();

    const pending = await api(server.url, '/api/possible-tasks');
    expect(pending.body.possibles.length).toBe(2);

    const promoteId = pending.body.possibles.find((p: any) => p.raw_title === 'Promote me').id;
    const dismissId = pending.body.possibles.find((p: any) => p.raw_title === 'Dismiss me').id;

    const promoted = await api(server.url, `/api/possible-tasks/${promoteId}/promote`, { method: 'POST', json: {} });
    expect(promoted.status).toBe(201);
    expect(promoted.body.task.title).toBe('Promote me');

    const dismissed = await api(server.url, `/api/possible-tasks/${dismissId}/dismiss`, { method: 'POST', json: {} });
    expect(dismissed.body.ok).toBe(true);

    const after = await api(server.url, '/api/possible-tasks');
    expect(after.body.possibles.length).toBe(0);
  });

  it('runs the reflow for a day via POST /api/schedule/run', async () => {
    // B1: /api/schedule/run now drives deterministic reflow and returns a ReflowDiff.
    const res = await api(server.url, '/api/schedule/run', { method: 'POST', json: { date: '2026-06-01' } });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.moved)).toBe(true);
    expect(Array.isArray(res.body.removed)).toBe(true);
    expect(Array.isArray(res.body.added)).toBe(true);
    expect(Array.isArray(res.body.unplaced)).toBe(true);
  });

  it('serves a day summary via GET /api/summary', async () => {
    const res = await api(server.url, '/api/summary?date=2026-06-01');
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-06-01');
    expect(typeof res.body.prose).toBe('string');
    expect(res.body.prose.length).toBeGreaterThan(0);
  });

  it('suggest-tags returns an array constrained to existing tags (empty when Ollama is down)', async () => {
    await api(server.url, '/api/tasks', { method: 'POST', json: { title: 'seed', tags: ['email'] } });
    const res = await api(server.url, '/api/tasks/suggest-tags', { method: 'POST', json: { title: 'Email Rek about the invoice' } });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tags)).toBe(true);
    for (const t of res.body.tags) expect(['email']).toContain(t); // never invents a tag
  });
});
