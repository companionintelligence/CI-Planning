import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Routine-promotion endpoints (PR-C+, Phase E + F). Three sister routes share
 * the same backend write path:
 *  - POST /api/patterns/promote-from-plan { plan_block_id, name? }
 *  - POST /api/patterns/promote-from-plan-template { template_id, name? }
 *  - POST /api/patterns/promote-from-tasks { task_ids, name? }
 *
 * Each yields a new Routine-type pattern with the source's member tasks in order.
 */

const OWNER = 1;
const DAY = '2026-06-22';

function insertTask(title: string, est = 30): number {
  return (sqlite
    .prepare(`INSERT INTO tasks (title, owner_id, status, estimated_minutes, priority) VALUES (?, ?, 'open', ?, 3) RETURNING id`)
    .get(title, OWNER, est) as { id: number }).id;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM block_templates; DELETE FROM pattern_tasks; DELETE FROM patterns WHERE id > 0;`);
});

describe('POST /api/patterns/promote-from-tasks', () => {
  it('creates a Routine with the given task ids in order', async () => {
    const a = insertTask('A');
    const b = insertTask('B');
    const r = await api(srv.url, '/api/patterns/promote-from-tasks', { method: 'POST', json: { task_ids: [a, b], name: 'Twins' } });
    expect(r.status).toBe(201);
    expect(r.body.pattern.name).toBe('Twins');
    expect(r.body.pattern.task_ids).toEqual([a, b]);
    const typeName = (sqlite.prepare(`SELECT name FROM pattern_types WHERE id = ?`).get(r.body.pattern.type_id) as { name: string }).name;
    expect(typeName).toBe('Routine');
  });

  it('422 on empty task_ids', async () => {
    expect((await api(srv.url, '/api/patterns/promote-from-tasks', { method: 'POST', json: { task_ids: [] } })).status).toBe(422);
    expect((await api(srv.url, '/api/patterns/promote-from-tasks', { method: 'POST', json: {} })).status).toBe(422);
  });

  it('422 if a task id doesn’t belong to the current owner', async () => {
    const t = insertTask('A');
    // a "foreign" task by inserting with no owner
    const foreign = (sqlite.prepare(`INSERT INTO tasks (title, status) VALUES ('X', 'open') RETURNING id`).get() as { id: number }).id;
    expect((await api(srv.url, '/api/patterns/promote-from-tasks', { method: 'POST', json: { task_ids: [t, foreign] } })).status).toBe(422);
  });
});

describe('POST /api/patterns/promote-from-plan', () => {
  it('creates a Routine with the Plan’s currently-attached member task blocks', async () => {
    const plan = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Big Plan', block_kind: 'timeblock', block_type: 'plan', start_at: `${DAY}T14:00:00.000Z`, end_at: `${DAY}T17:00:00.000Z` },
    })).body.block;
    const a = insertTask('A');
    const b = insertTask('B');
    // Attach two task blocks to the plan (PR-C parent_block_id).
    sqlite.prepare(`INSERT INTO time_blocks (task_id, title, block_kind, start_at, end_at, parent_block_id, status) VALUES (?, 'A', 'task', ?, ?, ?, 'planned')`)
      .run(a, `${DAY}T14:00:00.000Z`, `${DAY}T15:00:00.000Z`, plan.id);
    sqlite.prepare(`INSERT INTO time_blocks (task_id, title, block_kind, start_at, end_at, parent_block_id, status) VALUES (?, 'B', 'task', ?, ?, ?, 'planned')`)
      .run(b, `${DAY}T15:00:00.000Z`, `${DAY}T16:00:00.000Z`, plan.id);

    const r = await api(srv.url, '/api/patterns/promote-from-plan', { method: 'POST', json: { plan_block_id: plan.id, name: 'Routine from Big Plan' } });
    expect(r.status).toBe(201);
    expect(r.body.pattern.name).toBe('Routine from Big Plan');
    expect(r.body.pattern.task_ids.sort()).toEqual([a, b].sort());
  });

  it('404 on unknown plan_block_id', async () => {
    expect((await api(srv.url, '/api/patterns/promote-from-plan', { method: 'POST', json: { plan_block_id: 999999 } })).status).toBe(404);
  });

  it('422 when plan_block_id missing', async () => {
    expect((await api(srv.url, '/api/patterns/promote-from-plan', { method: 'POST', json: {} })).status).toBe(422);
  });
});

describe('POST /api/patterns/promote-from-plan-template', () => {
  it('creates fresh tasks from the template’s saved tasks and a Routine that owns them', async () => {
    const tpl = (await api(srv.url, '/api/block-templates', {
      method: 'POST',
      json: {
        name: 'Workday Start',
        default_minutes: 90,
        tasks: [
          { title: 'Plan the day', estimated_minutes: 15, offset_minutes: 0 },
          { title: 'Deep focus', estimated_minutes: 75, offset_minutes: 15 },
        ],
      },
    })).body.block_template;

    const r = await api(srv.url, '/api/patterns/promote-from-plan-template', { method: 'POST', json: { template_id: tpl.id } });
    expect(r.status).toBe(201);
    expect(r.body.pattern.name).toBe('Workday Start');
    expect(r.body.pattern.task_ids.length).toBe(2);
    // Each task id is a freshly-created task.
    const titles = r.body.pattern.task_ids.map((id: number) =>
      (sqlite.prepare(`SELECT title FROM tasks WHERE id = ?`).get(id) as { title: string }).title,
    );
    expect(titles).toEqual(['Plan the day', 'Deep focus']);
  });

  it('404 on unknown template_id; 422 when template_id missing', async () => {
    expect((await api(srv.url, '/api/patterns/promote-from-plan-template', { method: 'POST', json: { template_id: 999 } })).status).toBe(404);
    expect((await api(srv.url, '/api/patterns/promote-from-plan-template', { method: 'POST', json: {} })).status).toBe(422);
  });
});
