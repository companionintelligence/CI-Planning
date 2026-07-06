import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { taskTagNames, entityTagLevels } from '../src/services/tags.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

/**
 * Auto-scheduling finding 2 (the linchpin): promoting a possible-task must carry its
 * suggested tags onto the task's entity_tags, or the direction tag the Auto engine
 * matches on vanishes the moment an item becomes schedulable.
 */
describe('promote carries possible-task tags onto the task (linchpin)', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  const seedTag = (name: string, kind: 'direction' | 'intention'): string =>
    (sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, ?, ?) RETURNING id`).get(name, kind, SYSTEM_OWNER) as { id: string }).id;

  it('copies the direction (pattern) tag at level 1 and content tags at level 2', async () => {
    const work = seedTag('work', 'direction');
    const finance = seedTag('finance', 'intention');
    const pid = (
      sqlite
        .prepare(
          `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status, proposed_owner_id)
           VALUES (uuid7(), 'Send invoice', 'gmail', 'm1', 0.9, 'pending', ?) RETURNING id`,
        )
        .get(SYSTEM_OWNER) as { id: string }
    ).id;
    sqlite.prepare(`INSERT INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?), (?, ?)`).run(pid, work, pid, finance);

    const res = await api(srv.url, `/api/possible-tasks/${pid}/promote`, { method: 'POST', json: {} });
    expect(res.status).toBe(201);
    const taskId = res.body.task.id;

    // The direction tag is a level-1 task tag — exactly what the Auto engine reads.
    expect(taskTagNames(taskId)).toContain('work');

    const levels = entityTagLevels('task', taskId);
    expect(levels.find((l) => l.name === 'work')?.level).toBe(1);
    expect(levels.find((l) => l.name === 'finance')?.level).toBe(2); // content kept as secondary
  });

  it('promotes cleanly when the possible has no tags', async () => {
    const pid = (
      sqlite
        .prepare(
          `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status, proposed_owner_id)
           VALUES (uuid7(), 'Untagged', 'text', 't1', 0.5, 'pending', ?) RETURNING id`,
        )
        .get(SYSTEM_OWNER) as { id: string }
    ).id;
    const res = await api(srv.url, `/api/possible-tasks/${pid}/promote`, { method: 'POST', json: {} });
    expect(res.status).toBe(201);
    expect(taskTagNames(res.body.task.id)).toEqual([]);
  });
});
