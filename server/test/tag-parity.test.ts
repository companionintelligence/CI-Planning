import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { promotePossibles } from '../src/agents/groom.js';

/**
 * "Finish CON-3" · Wave 0 — the parity gate.
 *
 * Before any read is flipped onto `entity_tags` (Wave 1), prove that for EVERY
 * task the legacy `task_tags` set equals the `entity_tags` (level-1) set, across
 * every write path. This is the safety net for the read-flip and the entry-gate
 * for dropping `task_tags` (Wave 2). If it ever goes red, a write path stopped
 * dual-writing and flipping the reads would silently lose tags.
 */

const OWNER = SYSTEM_OWNER;

/** A task's tag-id set from the legacy store. */
function taskTagIds(id: string): string[] {
  return (sqlite.prepare('SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id').all(id) as { tag_id: string }[]).map((r) => r.tag_id);
}
/** A task's tag-id set from the normalized store (level 1 = top-level mirror of task_tags). */
function entityTaskTagIds(id: string): string[] {
  return (sqlite.prepare("SELECT tag_id FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ? AND level = 1 ORDER BY tag_id").all(id) as { tag_id: string }[]).map((r) => r.tag_id);
}
/** Every task whose two tag stores disagree — the invariant keeps this empty. */
function parityMismatches(): { id: string; task_tags: string[]; entity_tags: string[] }[] {
  const ids = (sqlite.prepare('SELECT id FROM tasks').all() as { id: string }[]).map((r) => r.id);
  const out: { id: string; task_tags: string[]; entity_tags: string[] }[] = [];
  for (const id of ids) {
    const a = taskTagIds(id);
    const b = entityTaskTagIds(id);
    if (a.join(',') !== b.join(',')) out.push({ id, task_tags: a, entity_tags: b });
  }
  return out;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('CON-3 finish · Wave 0 — task_tags ⇄ entity_tags parity', () => {
  it('create with tags → both stores hold the same ids', async () => {
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'A', tags: ['Work', 'Errands'] } });
    expect(taskTagIds(c.body.task.id).length).toBe(2);
    expect(parityMismatches()).toEqual([]);
  });

  it('PATCH replace → parity holds (replace, not append)', async () => {
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'B', tags: ['one', 'two'] } });
    const id = c.body.task.id as string;
    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { tags: ['three'] } });
    expect(taskTagIds(id).length).toBe(1);
    expect(parityMismatches()).toEqual([]);
  });

  it('clear tags → both stores empty', async () => {
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'C', tags: ['x'] } });
    const id = c.body.task.id as string;
    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { tags: [] } });
    expect(taskTagIds(id)).toEqual([]);
    expect(parityMismatches()).toEqual([]);
  });

  it('recall clone → the new task carries tags in both stores', async () => {
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'D', tags: ['alpha', 'beta'] } });
    const r = await api(srv.url, `/api/tasks/${c.body.task.id}/recall`, { method: 'POST' });
    expect(taskTagIds(r.body.task.id).length).toBe(2);
    expect(parityMismatches()).toEqual([]);
  });

  it('quick-add → parity holds', async () => {
    await api(srv.url, '/api/tasks/quick', { method: 'POST', json: { text: 'buy milk #errands' } });
    expect(parityMismatches()).toEqual([]);
  });

  // The gap this wave exists to catch: the nightly promotion carried inbox tags
  // into task_tags ONLY. With the CON-3 mirror added in groom.ts, a promoted task
  // is tagged in both stores.
  it('groom promotion carries inbox tags into BOTH stores', async () => {
    const tagId = (sqlite.prepare('INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id').get('inbox') as { id: string }).id;
    const pid = (sqlite
      .prepare(`INSERT INTO possible_tasks (id, raw_title, confidence, status, proposed_owner_id) VALUES (uuid7(), ?, ?, 'pending', ?) RETURNING id`)
      .get('Promote me', 0.9, OWNER) as { id: string }).id;
    sqlite.prepare('INSERT INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)').run(pid, tagId);

    promotePossibles();

    const newTaskId = (sqlite.prepare("SELECT id FROM tasks WHERE title = 'Promote me'").get() as { id: string }).id;
    expect(taskTagIds(newTaskId)).toEqual([tagId]);
    expect(entityTaskTagIds(newTaskId)).toEqual([tagId]); // would be [] before the groom fix
    expect(parityMismatches()).toEqual([]);
  });

  // Pins the Wave-1 ORDER contract: the old `task_tags` read returned tags in PK
  // (tag_id) order; the read-flip must preserve it (the client treats tags[0] as the
  // primary tag and persists it). The baseline snapshot CANNOT catch this — its
  // normalizer sorts tag arrays — so it is pinned here with an order-sensitive assert.
  it('serialized tag order follows tag_id (old task_tags PK order), not alphabetical', async () => {
    // Two tags whose id order is the REVERSE of alphabetical: 'zzz' gets the smaller id.
    sqlite.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run('11111111-1111-7111-8111-111111111111', 'zzz');
    sqlite.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run('22222222-2222-7222-8222-222222222222', 'aaa');
    const c = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Ordered', tags: ['aaa', 'zzz'] } });
    const id = c.body.task.id as string;
    const list = await api(srv.url, '/api/tasks');
    const got = (list.body.tasks as { id: string; tags: string[] }[]).find((x) => x.id === id);
    // tag_id order (zzz < aaa); alphabetical would be ['aaa','zzz'].
    expect(got?.tags).toEqual(['zzz', 'aaa']);
  });
});
