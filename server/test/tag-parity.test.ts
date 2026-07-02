import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { promotePossibles } from '../src/agents/groom.js';

/**
 * CON-3 task-tag read path (Waves 1–2). `entity_tags` (entity_kind='task', level 1)
 * is the SOLE task-tag store — `task_tags` was dropped in migration 0041. These guard
 * that tags written through every path read back correctly, in tag_id order (the
 * client's `tags[0]` "primary" tag), and that the legacy table is really gone.
 */

const OWNER = SYSTEM_OWNER;

/** A task's tag-id set from the canonical store (level 1). */
function taskTagIds(id: string): string[] {
  return (sqlite.prepare("SELECT tag_id FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ? AND level = 1 ORDER BY tag_id").all(id) as { tag_id: string }[]).map((r) => r.tag_id);
}
/** The tag names the API serves for a task (the read path), in served order. */
async function apiTags(id: string): Promise<string[] | undefined> {
  const list = await api(srv.url, '/api/tasks');
  return (list.body.tasks as { id: string; tags: string[] }[]).find((x) => x.id === id)?.tags;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('CON-3 — entity_tags is the sole task-tag store (Wave 2)', () => {
  it('the task_tags table no longer exists', () => {
    const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_tags'").get();
    expect(row).toBeUndefined();
  });

  it('create with tags → stored in entity_tags + served by the API', async () => {
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'A', tags: ['Work', 'Errands'] } });
    const id = c.body.task.id as string;
    expect(taskTagIds(id).length).toBe(2);
    expect((await apiTags(id))?.slice().sort()).toEqual(['errands', 'work']);
  });

  it('PATCH replaces the set (replace, not append)', async () => {
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'B', tags: ['one', 'two'] } });
    const id = c.body.task.id as string;
    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { tags: ['three'] } });
    expect(await apiTags(id)).toEqual(['three']);
  });

  it('clear tags → empty', async () => {
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'C', tags: ['x'] } });
    const id = c.body.task.id as string;
    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { tags: [] } });
    expect(taskTagIds(id)).toEqual([]);
    expect(await apiTags(id)).toEqual([]);
  });

  it('recall clone carries tags', async () => {
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'D', tags: ['alpha', 'beta'] } });
    const r = await api(srv.url, `/api/tasks/${c.body.task.id}/recall`, { method: 'POST' });
    expect(taskTagIds(r.body.task.id).length).toBe(2);
  });

  it('groom promotion carries inbox tags into entity_tags', async () => {
    const tagId = (sqlite.prepare('INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), ?, ?) RETURNING id').get('inbox', OWNER) as { id: string }).id;
    const pid = (sqlite
      .prepare(`INSERT INTO possible_tasks (id, raw_title, confidence, status, proposed_owner_id) VALUES (uuid7(), ?, ?, 'pending', ?) RETURNING id`)
      .get('Promote me', 0.9, OWNER) as { id: string }).id;
    sqlite.prepare('INSERT INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)').run(pid, tagId);

    promotePossibles();

    const newTaskId = (sqlite.prepare("SELECT id FROM tasks WHERE title = 'Promote me'").get() as { id: string }).id;
    expect(taskTagIds(newTaskId)).toEqual([tagId]);
  });

  // Order contract: served tags follow tag_id (the old task_tags PK order the client
  // relies on for tags[0]); the baseline snapshot can't catch it (its normalizer sorts).
  it('serialized tag order follows tag_id, not alphabetical', async () => {
    // Two tags whose id order is the REVERSE of alphabetical: 'zzz' gets the smaller id.
    sqlite.prepare('INSERT INTO tags (id, name, owner_id) VALUES (?, ?, ?)').run('11111111-1111-7111-8111-111111111111', 'zzz', OWNER);
    sqlite.prepare('INSERT INTO tags (id, name, owner_id) VALUES (?, ?, ?)').run('22222222-2222-7222-8222-222222222222', 'aaa', OWNER);
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Ordered', tags: ['aaa', 'zzz'] } });
    // tag_id order (zzz < aaa); alphabetical would be ['aaa','zzz'].
    expect(await apiTags(c.body.task.id)).toEqual(['zzz', 'aaa']);
  });
});
