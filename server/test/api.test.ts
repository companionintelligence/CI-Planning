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
    expect(id).toBeGreaterThan(0);

    const list = await api(server.url, '/api/tasks');
    expect(list.body.tasks.find((t: any) => t.id === id)?.tags).toEqual(expect.arrayContaining(['eng', 'docs']));

    const patched = await api(server.url, `/api/tasks/${id}`, { method: 'PATCH', json: { completed: true } });
    expect(patched.body.task.status).toBe('done');
    expect(patched.body.task.completedAt ?? patched.body.task.completed_at).toBeTruthy();

    const cancelled = await api(server.url, `/api/tasks/${id}`, { method: 'DELETE' });
    expect(cancelled.body.task.status).toBe('cancelled');
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
        `INSERT INTO possible_tasks (raw_title, source_kind, source_ref, confidence, status)
         VALUES ('Promote me', 'gmail', 'x#0', 0.9, 'pending'), ('Dismiss me', 'gmail', 'y#0', 0.4, 'pending')`
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

  it('runs the scheduler for a day via POST /api/schedule/run', async () => {
    await api(server.url, '/api/tasks', { method: 'POST', json: { title: 'Deep work', priority: 1, estimated_minutes: 60 } });
    const res = await api(server.url, '/api/schedule/run', { method: 'POST', json: { date: '2026-06-01' } });
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-06-01');
    expect(res.body.blocksCreated).toBeGreaterThanOrEqual(1);
  });

  it('serves a day summary via GET /api/summary', async () => {
    const res = await api(server.url, '/api/summary?date=2026-06-01');
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-06-01');
    expect(typeof res.body.prose).toBe('string');
    expect(res.body.prose.length).toBeGreaterThan(0);
  });
});
