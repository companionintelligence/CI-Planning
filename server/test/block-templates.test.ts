/**
 * §M — apply a saved block template to an EXISTING Plan container, swapping its
 * contents: current child task-blocks are cleared (their tasks return to the open
 * backlog, not deleted) and the template's tasks are materialized in their place
 * (parented + flipped to scheduled). The shared materialize path still backs
 * `instantiate` unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

const taskStatus = (id: string) => (sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as { status: string }).status;
const childBlocks = (planId: string) =>
  sqlite.prepare(`SELECT id, task_id FROM time_blocks WHERE parent_block_id = ?`).all(planId) as { id: string; task_id: string | null }[];

async function makePlanWithTask(): Promise<{ plan: string; oldTask: string }> {
  // A Plan container spanning a 2h window.
  const plan = (await api(srv.url, '/api/blocks', {
    method: 'POST', json: { title: 'Morning', block_kind: 'timeblock', start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T18:00:00.000Z' },
  })).body.block.id;
  // An existing open task placed inside it (POST flips it to scheduled), then parented.
  const oldTask = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'Old', ?, 'open') RETURNING id`).get(SYSTEM_OWNER) as { id: string }).id;
  const child = (await api(srv.url, '/api/blocks', {
    method: 'POST', json: { task_id: oldTask, title: 'Old', block_kind: 'task', start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T16:30:00.000Z' },
  })).body.block.id;
  await api(srv.url, `/api/blocks/${child}`, { method: 'PATCH', json: { parent_block_id: plan } });
  return { plan, oldTask };
}

async function makeTemplate(): Promise<string> {
  const r = await api(srv.url, '/api/block-templates', {
    method: 'POST',
    json: { name: 'Gym morning', default_minutes: 120, tasks: [
      { title: 'Warm up', estimated_minutes: 15, offset_minutes: 0 },
      { title: 'Lift', estimated_minutes: 45, offset_minutes: 20 },
    ] },
  });
  return r.body.block_template.id;
}

describe('POST /api/block-templates/:id/apply-to-block', () => {
  it('clears current tasks (back to open) and repopulates from the template as scheduled', async () => {
    const { plan, oldTask } = await makePlanWithTask();
    const tmpl = await makeTemplate();
    expect(taskStatus(oldTask)).toBe('scheduled');

    const res = await api(srv.url, `/api/block-templates/${tmpl}/apply-to-block`, { method: 'POST', json: { block_id: plan } });
    expect(res.status).toBe(200);

    // Old task's placement was removed → it returns to the open backlog (task survives).
    expect(taskStatus(oldTask)).toBe('open');
    // The block now holds exactly the template's two tasks, each scheduled.
    const kids = childBlocks(plan).filter((k) => k.task_id);
    expect(kids).toHaveLength(2);
    for (const k of kids) expect(taskStatus(k.task_id!)).toBe('scheduled');
    const titles = kids.map((k) => (sqlite.prepare(`SELECT title FROM tasks WHERE id = ?`).get(k.task_id) as { title: string }).title).sort();
    expect(titles).toEqual(['Lift', 'Warm up']);
  });

  it('404 for an unknown block', async () => {
    const tmpl = await makeTemplate();
    const res = await api(srv.url, `/api/block-templates/${tmpl}/apply-to-block`, { method: 'POST', json: { block_id: 'nope' } });
    expect(res.status).toBe(404);
  });

  it('instantiate still creates a fresh container + tasks (unchanged path)', async () => {
    const tmpl = await makeTemplate();
    const res = await api(srv.url, `/api/block-templates/${tmpl}/instantiate`, { method: 'POST', json: { start_at: '2026-06-23T16:00:00.000Z' } });
    expect(res.status).toBe(201);
    expect(res.body.block.block_kind).toBe('timeblock');
    // Two template tasks materialized as real tasks.
    const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title IN ('Warm up', 'Lift')`).get() as { n: number }).n;
    expect(n).toBe(2);
  });
});
