import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Time-Block containers + reusable templates (Phase G, G3). A container is a
 * `block_kind='timeblock'` time_blocks row with a grouping tag; templates save a
 * named/tagged container with a default duration and re-instantiate it onto a day.
 */

const blockRow = (id: number) => sqlite.prepare(`SELECT * FROM time_blocks WHERE id = ?`).get(id) as any;
const containerCount = () =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM time_blocks WHERE block_kind = 'timeblock'`).get() as { c: number }).c;

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

beforeEach(() => {
  resetDb(); // clears time_blocks/tasks; block_templates isn't in resetDb — clear it too
  sqlite.exec(`DELETE FROM block_templates;`);
});

describe('time-block containers', () => {
  it('creates a tagged container block (block_kind=timeblock)', async () => {
    const { status, body } = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Errands', block_kind: 'timeblock', tag: 'errands', start_at: '2026-06-20T16:00:00.000Z', end_at: '2026-06-20T18:00:00.000Z' },
    });
    expect(status).toBe(201);
    expect(body.block.block_kind).toBe('timeblock');
    expect(body.block.tag).toBe('errands');
    expect(body.block.is_auto).toBe(false); // manual → never cleared by the scheduler
  });

  it('renames + retags a container via PATCH', async () => {
    const b = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'errands', block_kind: 'timeblock', tag: 'errands', start_at: '2026-06-20T16:00:00.000Z', end_at: '2026-06-20T17:00:00.000Z' },
    })).body.block;
    const u = await api(srv.url, `/api/blocks/${b.id}`, { method: 'PATCH', json: { title: 'Saturday errands', tag: 'weekend' } });
    expect(u.status).toBe(200);
    expect(u.body.block.title).toBe('Saturday errands');
    expect(u.body.block.tag).toBe('weekend');
  });

  it('a container survives an auto-schedule run (is_auto=0, not a task)', async () => {
    const b = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Deep work', block_kind: 'timeblock', tag: 'work', start_at: '2026-06-20T09:00:00.000Z', end_at: '2026-06-20T12:00:00.000Z' },
    })).body.block;
    await api(srv.url, '/api/schedule/run', { method: 'POST', json: {} });
    expect(blockRow(b.id)).toBeTruthy(); // not cleared
    // It's a block, never a task in the backlog.
    const tasks = (await api(srv.url, '/api/tasks')).body.tasks;
    expect(tasks.some((t: any) => t.title === 'Deep work')).toBe(false);
  });
});

describe('block templates', () => {
  it('saves, lists, instantiates (independent block), and deletes', async () => {
    const t = (await api(srv.url, '/api/block-templates', { method: 'POST', json: { name: 'Errands', tag: 'errands', default_minutes: 90 } })).body.block_template;
    expect(t.name).toBe('Errands');

    const list = await api(srv.url, '/api/block-templates');
    expect(list.body.block_templates.map((x: any) => x.name)).toContain('Errands');

    const inst = await api(srv.url, `/api/block-templates/${t.id}/instantiate`, { method: 'POST', json: { start_at: '2026-06-20T16:00:00.000Z' } });
    expect(inst.status).toBe(201);
    expect(inst.body.block.block_kind).toBe('timeblock');
    expect(inst.body.block.tag).toBe('errands');
    expect(inst.body.block.title).toBe('Errands');
    expect(inst.body.block.end_at).toBe('2026-06-20T17:30:00.000Z'); // start + 90m

    const del = await api(srv.url, `/api/block-templates/${t.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await api(srv.url, '/api/block-templates')).body.block_templates.length).toBe(0);
  });

  it('instantiating twice yields two independent containers', async () => {
    const t = (await api(srv.url, '/api/block-templates', { method: 'POST', json: { name: 'Focus', tag: 'work', default_minutes: 60 } })).body.block_template;
    const a = (await api(srv.url, `/api/block-templates/${t.id}/instantiate`, { method: 'POST', json: { start_at: '2026-06-20T09:00:00.000Z' } })).body.block;
    const b = (await api(srv.url, `/api/block-templates/${t.id}/instantiate`, { method: 'POST', json: { start_at: '2026-06-21T09:00:00.000Z' } })).body.block;
    expect(a.id).not.toBe(b.id);
    expect(containerCount()).toBe(2);
  });

  it('rejects a nameless template (422) and a missing start_at on instantiate (422)', async () => {
    expect((await api(srv.url, '/api/block-templates', { method: 'POST', json: {} })).status).toBe(422);
    const t = (await api(srv.url, '/api/block-templates', { method: 'POST', json: { name: 'X' } })).body.block_template;
    expect((await api(srv.url, `/api/block-templates/${t.id}/instantiate`, { method: 'POST', json: {} })).status).toBe(422);
  });
});
