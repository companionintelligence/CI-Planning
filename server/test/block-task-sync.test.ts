import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * REQ2: block ⇄ task scheduling sync. A placed task IS scheduled, so its
 * scheduling-intent fields mirror the block's placement (and vice-versa). The owner's
 * timezone is pinned to America/Los_Angeles so the tz-correct date derivation is
 * actually exercised (a server-tz shortcut would put `scheduled_for` on the wrong day).
 */
const OWNER = SYSTEM_OWNER;
const TZ = 'America/Los_Angeles';

function insertTask(title: string, opts: { est?: number; taskTime?: string; scheduledFor?: string } = {}): string {
  return (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, task_time, scheduled_for)
       VALUES (uuid7(), ?, ?, 'open', ?, ?, ?) RETURNING id`,
    )
    .get(title, OWNER, opts.est ?? 30, opts.taskTime ?? null, opts.scheduledFor ?? null) as { id: string }).id;
}

function insertBlock(opts: {
  taskId?: string | null; start: string; end: string; kind?: string; allDay?: number; parent?: string | null;
}): string {
  return (sqlite
    .prepare(
      `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_auto, source_kind, status, all_day, parent_block_id)
       VALUES (uuid7(), ?, 'B', ?, ?, ?, 0, 'manual', 'planned', ?, ?) RETURNING id`,
    )
    .get(opts.taskId ?? null, opts.kind ?? 'task', opts.start, opts.end, opts.allDay ?? 0, opts.parent ?? null) as { id: string }).id;
}

const taskRow = (id: string) =>
  sqlite.prepare(`SELECT scheduled_for, task_time, status, completed_at FROM tasks WHERE id = ?`).get(id) as
    { scheduled_for: string | null; task_time: string | null; status: string; completed_at: string | null };
const blockRow = (id: string) =>
  sqlite.prepare(`SELECT start_at, end_at FROM time_blocks WHERE id = ?`).get(id) as { start_at: string; end_at: string };

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?`).run(TZ, OWNER);
});

describe('block → task sync (PATCH /api/blocks/:id)', () => {
  it('mirrors a moved block onto the task in the OWNER timezone (crossing local midnight)', async () => {
    const task = insertTask('Write report');
    const block = insertBlock({ taskId: task, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T16:30:00.000Z' });

    // 03:00Z on the 22nd is 20:00 on the 21st in Los Angeles (PDT, UTC-7).
    const r = await api(srv.url, `/api/blocks/${block}`, {
      method: 'PATCH', json: { start_at: '2026-06-22T03:00:00.000Z', end_at: '2026-06-22T03:30:00.000Z' },
    });
    expect(r.status).toBe(200);
    const t = taskRow(task);
    expect(t.scheduled_for).toBe('2026-06-21'); // previous local day — not the UTC date
    expect(t.task_time).toBe('20:00');
  });

  it('only the earliest placement owns the task fields (a later session is a no-op)', async () => {
    const task = insertTask('Two sessions');
    insertBlock({ taskId: task, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T16:30:00.000Z' }); // 09:00 LA (earliest)
    const later = insertBlock({ taskId: task, start: '2026-06-22T18:00:00.000Z', end: '2026-06-22T18:30:00.000Z' }); // 11:00 LA

    await api(srv.url, `/api/blocks/${later}`, { method: 'PATCH', json: { start_at: '2026-06-22T22:00:00.000Z', end_at: '2026-06-22T22:30:00.000Z' } });
    // The later session moved, but the task stays anchored (no scheduling write).
    expect(taskRow(task).scheduled_for).toBeNull();
    expect(taskRow(task).task_time).toBeNull();
  });

  it('an all-day block clears task_time (no clock time) but still sets scheduled_for', async () => {
    const task = insertTask('All day thing', { taskTime: '09:00' });
    const block = insertBlock({ taskId: task, start: '2026-06-22T07:00:00.000Z', end: '2026-06-23T07:00:00.000Z', allDay: 1 });
    await api(srv.url, `/api/blocks/${block}`, { method: 'PATCH', json: { start_at: '2026-06-23T07:00:00.000Z', end_at: '2026-06-24T07:00:00.000Z' } });
    expect(taskRow(task).task_time).toBeNull();
    expect(taskRow(task).scheduled_for).toBe('2026-06-23'); // 00:00 LA on the 23rd
  });

  it('a block with no linked task is a safe no-op', async () => {
    const block = insertBlock({ taskId: null, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T17:00:00.000Z', kind: 'focus' });
    const r = await api(srv.url, `/api/blocks/${block}`, { method: 'PATCH', json: { start_at: '2026-06-22T18:00:00.000Z', end_at: '2026-06-22T19:00:00.000Z' } });
    expect(r.status).toBe(200);
  });
});

describe('block done-state mirror', () => {
  it('completing a task-linked block marks the task done; un-completing returns it to scheduled', async () => {
    const task = insertTask('Finish me');
    const block = insertBlock({ taskId: task, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T16:30:00.000Z' });

    await api(srv.url, `/api/blocks/${block}`, { method: 'PATCH', json: { status: 'completed' } });
    let t = taskRow(task);
    expect(t.status).toBe('done');
    expect(t.completed_at).toBeTruthy();

    // Un-completing a still-placed task returns it to `scheduled` (it still owns a block),
    // not all the way back to the open backlog.
    await api(srv.url, `/api/blocks/${block}`, { method: 'PATCH', json: { status: 'planned' } });
    t = taskRow(task);
    expect(t.status).toBe('scheduled');
    expect(t.completed_at).toBeNull();
  });
});

describe('placement status (open ↔ scheduled)', () => {
  const fieldTs = (id: string) =>
    JSON.parse((sqlite.prepare(`SELECT field_ts FROM tasks WHERE id = ?`).get(id) as { field_ts: string | null }).field_ts ?? '{}');

  it('POST /api/blocks flips an open task to scheduled, sets scheduling fields, and stamps status', async () => {
    const task = insertTask('Place me');
    const r = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { task_id: task, title: 'Place me', block_kind: 'task', start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T16:30:00.000Z' },
    });
    expect(r.status).toBe(201);
    const t = taskRow(task);
    expect(t.status).toBe('scheduled');
    expect(t.scheduled_for).toBe('2026-06-22'); // 16:00Z = 09:00 LA
    expect(t.task_time).toBe('09:00');
    expect(fieldTs(task).status).toBeTruthy(); // Phase-L sync stamp advanced
  });

  it('deleting the placement returns the task to the open backlog', async () => {
    const task = insertTask('Place then remove');
    const created = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { task_id: task, title: 'x', block_kind: 'task', start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T16:30:00.000Z' },
    });
    expect(taskRow(task).status).toBe('scheduled');
    await api(srv.url, `/api/blocks/${created.body.block.id}`, { method: 'DELETE' });
    expect(taskRow(task).status).toBe('open');
  });

  it('deleting a Plan with ?children=delete reverts every child task', async () => {
    const t1 = insertTask('child 1');
    const t2 = insertTask('child 2');
    const plan = (await api(srv.url, '/api/blocks', {
      method: 'POST', json: { title: 'Plan', block_kind: 'timeblock', start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T18:00:00.000Z' },
    })).body.block.id;
    for (const [tid, s] of [[t1, '16:00'], [t2, '16:45']] as const) {
      const c = await api(srv.url, '/api/blocks', {
        method: 'POST', json: { task_id: tid, title: 'c', block_kind: 'task', start_at: `2026-06-22T${s}:00.000Z`, end_at: `2026-06-22T${s}:00.000Z` },
      });
      await api(srv.url, `/api/blocks/${c.body.block.id}`, { method: 'PATCH', json: { parent_block_id: plan } });
    }
    expect(taskRow(t1).status).toBe('scheduled');
    expect(taskRow(t2).status).toBe('scheduled');

    await api(srv.url, `/api/blocks/${plan}?children=delete`, { method: 'DELETE' });
    expect(taskRow(t1).status).toBe('open');
    expect(taskRow(t2).status).toBe('open');
  });

  it('placement never overrides a done/cancelled task', async () => {
    const done = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'D', ?, 'done') RETURNING id`).get(OWNER) as { id: string }).id;
    await api(srv.url, '/api/blocks', {
      method: 'POST', json: { task_id: done, title: 'D', block_kind: 'task', start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T16:30:00.000Z' },
    });
    expect(taskRow(done).status).toBe('done'); // unchanged
  });
});

describe('move-group → task sync', () => {
  it('shifting a group mirrors each moved task member onto its task', async () => {
    const task = insertTask('Grouped');
    const block = insertBlock({ taskId: task, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T16:30:00.000Z' }); // 09:00 LA
    await api(srv.url, `/api/blocks/${block}/move-group`, { method: 'POST', json: { delta_minutes: 60 } });
    // Block now at 10:00 LA → task_time mirrors.
    expect(taskRow(task).task_time).toBe('10:00');
    expect(taskRow(task).scheduled_for).toBe('2026-06-22');
  });
});

describe('task → block sync (reverse, PATCH /api/tasks/:id)', () => {
  it('editing the task time/day moves its placed block in lockstep', async () => {
    const task = insertTask('Move me', { est: 30 });
    const block = insertBlock({ taskId: task, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T16:30:00.000Z' });

    await api(srv.url, `/api/tasks/${task}`, { method: 'PATCH', json: { scheduled_for: '2026-06-22', task_time: '14:00' } });
    // 14:00 LA (PDT) == 21:00 UTC.
    expect(blockRow(block).start_at).toBe('2026-06-22T21:00:00.000Z');
    expect(blockRow(block).end_at).toBe('2026-06-22T21:30:00.000Z'); // 30-min span preserved
  });

  it('editing the estimate resizes the placed block', async () => {
    const task = insertTask('Resize me', { est: 30, scheduledFor: '2026-06-22', taskTime: '14:00' });
    const block = insertBlock({ taskId: task, start: '2026-06-22T21:00:00.000Z', end: '2026-06-22T21:30:00.000Z' });

    await api(srv.url, `/api/tasks/${task}`, { method: 'PATCH', json: { estimated_minutes: 90 } });
    const b = blockRow(block);
    expect(Date.parse(b.end_at) - Date.parse(b.start_at)).toBe(90 * 60_000);
  });

  it('editing only the task time does NOT revert a manual block resize (#1)', async () => {
    // Estimate is 30, but the block was manually resized to a 60-min span.
    const task = insertTask('Manual resize', { est: 30 });
    const block = insertBlock({ taskId: task, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T17:00:00.000Z' });

    await api(srv.url, `/api/tasks/${task}`, { method: 'PATCH', json: { task_time: '10:00' } });
    const b = blockRow(block);
    // Block moved to 10:00 local but its 60-min span is preserved (not snapped back to 30).
    expect(Date.parse(b.end_at) - Date.parse(b.start_at)).toBe(60 * 60_000);
  });
});

describe('correctness fixes (#2, #3)', () => {
  it('moving a recurring instance block updates occurrence_date in lockstep with scheduled_for (#2)', async () => {
    const parent = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, recurrence_rule) VALUES (uuid7(), 'Tmpl', ?, 'recurring', 'FREQ=DAILY') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    const tid = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, occurrence_date, recurrence_parent_id)
                VALUES (uuid7(), 'Recurring', ?, 'open', '2026-06-22', ?) RETURNING id`)
      .get(OWNER, parent) as { id: string }).id;
    const block = insertBlock({ taskId: tid, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T16:30:00.000Z' });

    await api(srv.url, `/api/blocks/${block}`, { method: 'PATCH', json: { start_at: '2026-06-23T16:00:00.000Z', end_at: '2026-06-23T16:30:00.000Z' } });
    const r = sqlite.prepare(`SELECT scheduled_for, occurrence_date FROM tasks WHERE id = ?`).get(tid) as
      { scheduled_for: string; occurrence_date: string };
    expect(r.scheduled_for).toBe('2026-06-23'); // 16:00Z == 09:00 LA on the 23rd
    expect(r.occurrence_date).toBe('2026-06-23'); // instance day moved too, not left stale
  });

  it('a non-recurring task is unaffected (occurrence_date stays null) (#2)', async () => {
    const task = insertTask('One-off');
    const block = insertBlock({ taskId: task, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T16:30:00.000Z' });
    await api(srv.url, `/api/blocks/${block}`, { method: 'PATCH', json: { start_at: '2026-06-23T16:00:00.000Z', end_at: '2026-06-23T16:30:00.000Z' } });
    const r = sqlite.prepare(`SELECT occurrence_date FROM tasks WHERE id = ?`).get(task) as { occurrence_date: string | null };
    expect(r.occurrence_date).toBeNull();
  });

  it('a same-PATCH time-change + complete leaves no auto reminders for the done task (#3)', async () => {
    const task = insertTask('Done with reminder');
    const block = insertBlock({ taskId: task, start: '2026-06-22T16:00:00.000Z', end: '2026-06-22T16:30:00.000Z' });

    await api(srv.url, `/api/blocks/${block}`, {
      method: 'PATCH', json: { start_at: '2026-06-22T18:00:00.000Z', end_at: '2026-06-22T18:30:00.000Z', status: 'completed' },
    });
    expect(taskRow(task).status).toBe('done');
    const rem = sqlite.prepare(`SELECT COUNT(*) AS c FROM reminders WHERE task_id = ? AND source = 'auto'`).get(task) as { c: number };
    expect(rem.c).toBe(0); // reminders re-derived after the status flip → none for a done task
  });
});
