/**
 * Phase N1 — objectives CRUD + task linking + rollup + cadence push.
 * Tests written BEFORE the implementation (spec N1 Tests: section).
 * All pinned dates avoid time-bomb failures under TZ=UTC.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { advanceObjectives } from '../src/jobs/advance-objectives.js';

// Pinned dates — 2026-06-15 is Monday W25.
const NOW = '2026-06-15T12:00:00.000Z';
const LONG_AGO = '2026-01-01T00:00:00.000Z';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM objective_tasks; DELETE FROM objectives;`);
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function insertTask(title: string, est?: number, status = 'open'): string {
  return (sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority)
     VALUES (uuid7(), ?, ?, ?, ?, 3) RETURNING id`
  ).get(title, SYSTEM_OWNER, status, est ?? null) as { id: string }).id;
}

function insertObjective(fields: {
  title: string;
  parent_id?: string | null;
  cadence?: string;
  status?: string;
  target_date?: string | null;
  last_advanced_at?: string | null;
  progress_cache?: number | null;
}): string {
  return (sqlite.prepare(`
    INSERT INTO objectives (id, owner_id, parent_id, title, level, horizon, status,
      cadence, target_date, last_advanced_at, progress_cache, created_at, updated_at)
    VALUES (uuid7(), ?, ?, ?, 'goal', 'none', ?, ?, ?, ?, ?,  ?, ?)
    RETURNING id
  `).get(
    SYSTEM_OWNER,
    fields.parent_id ?? null,
    fields.title,
    fields.status ?? 'active',
    fields.cadence ?? 'none',
    fields.target_date ?? null,
    fields.last_advanced_at ?? null,
    fields.progress_cache ?? null,
    NOW, NOW,
  ) as { id: string }).id;
}

function linkTask(objectiveId: string, taskId: string): void {
  sqlite.prepare(`INSERT INTO objective_tasks (objective_id, task_id) VALUES (?, ?)`).run(objectiveId, taskId);
}

function fpRows(): { task_id: string; source_kind: string; source_ref: string | null }[] {
  return sqlite.prepare(`SELECT task_id, source_kind, source_ref FROM flight_plan ORDER BY position`).all() as ReturnType<typeof fpRows>;
}

// ── GET /api/objectives ────────────────────────────────────────────────────────

describe('GET /api/objectives', () => {
  it('returns empty list when no objectives', async () => {
    const res = await api(srv.url, '/api/objectives');
    expect(res.status).toBe(200);
    expect(res.body.objectives).toEqual([]);
  });

  it('returns root objectives with null progress when no tasks linked', async () => {
    insertObjective({ title: 'Write a book' });
    const res = await api(srv.url, '/api/objectives');
    expect(res.status).toBe(200);
    const obj = res.body.objectives[0];
    expect(obj.title).toBe('Write a book');
    expect(obj.progress_cache).toBeNull();
    expect(obj.next_action).toBeNull();
  });

  it('nests children under parents', async () => {
    const gId = insertObjective({ title: 'Learn guitar' });
    insertObjective({ title: 'Learn chords', parent_id: gId });
    const res = await api(srv.url, '/api/objectives');
    const root = res.body.objectives;
    expect(root).toHaveLength(1);
    expect(root[0].title).toBe('Learn guitar');
    expect(root[0].children).toHaveLength(1);
    expect(root[0].children[0].title).toBe('Learn chords');
  });

  it('surfaces next_action from a directly-linked incomplete task', async () => {
    const id = insertObjective({ title: 'Ship N1' });
    const t = insertTask('Write objectives route');
    linkTask(id, t);
    const res = await api(srv.url, '/api/objectives');
    expect(res.body.objectives[0].next_action).not.toBeNull();
    expect(res.body.objectives[0].next_action.id).toBe(t);
  });

  it('recursive CTE: next_action can be a grandchild task', async () => {
    const goal = insertObjective({ title: 'Run a marathon' });
    const proj = insertObjective({ title: 'Build base fitness', parent_id: goal });
    const t = insertTask('Run 5k today');
    linkTask(proj, t);
    const res = await api(srv.url, '/api/objectives');
    const root = res.body.objectives[0];
    // Goal has no direct links but its subtree has a task.
    expect(root.next_action).not.toBeNull();
    expect(root.next_action.id).toBe(t);
  });

  it('effective_target = max target_date across subtree', async () => {
    const goal = insertObjective({ title: 'Retire early', target_date: '2035-01-01' });
    insertObjective({ title: 'Save 100k', parent_id: goal, target_date: '2028-06-01' });
    insertObjective({ title: 'Earn promotion', parent_id: goal, target_date: '2027-01-01' });
    const res = await api(srv.url, '/api/objectives');
    // Goal's effective_target = max(2035-01-01, 2028-06-01, 2027-01-01) = 2035-01-01
    expect(res.body.objectives[0].effective_target).toBe('2035-01-01');
  });

  it('effective_target from child is used when child date exceeds parent', async () => {
    const goal = insertObjective({ title: 'Short goal', target_date: '2026-12-31' });
    insertObjective({ title: 'Long sub-project', parent_id: goal, target_date: '2027-06-30' });
    const res = await api(srv.url, '/api/objectives');
    expect(res.body.objectives[0].effective_target).toBe('2027-06-30');
  });

  it('owner isolation — does not return objectives for another owner', async () => {
    insertObjective({ title: 'Mine' });
    // Attempting to insert for a nonexistent owner_id should fail at FK.
    expect(() =>
      sqlite.prepare(`INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, created_at, updated_at)
         VALUES (uuid7(), 'ghost', 'Theirs', 'goal', 'none', 'active', 'none', ?, ?)`).run(NOW, NOW)
    ).toThrow(/FOREIGN KEY/);
  });
});

// ── POST /api/objectives ───────────────────────────────────────────────────────

describe('POST /api/objectives', () => {
  // Levels are HEIGHT-based (bottom-up): a childless node is a leaf 'objective', a node
  // of objectives is a 'project', a node of projects is a 'goal'.
  const levelOf = async (id: string): Promise<string> => {
    const tree = (await api(srv.url, '/api/objectives', { method: 'GET' })).body.objectives as any[];
    const find = (nodes: any[]): any => { for (const n of nodes) { if (n.id === id) return n; const f = find(n.children ?? []); if (f) return f; } return null; };
    return find(tree)?.level;
  };

  it('a lone objective is a leaf (level=objective)', async () => {
    const res = await api(srv.url, '/api/objectives', {
      method: 'POST',
      json: { title: 'Write a novel', horizon: 'year' },
    });
    expect(res.status).toBe(201);
    expect(res.body.objective.level).toBe('objective');
    expect(res.body.objective.title).toBe('Write a novel');
  });

  it('ignores client-supplied level (server derives from height)', async () => {
    const res = await api(srv.url, '/api/objectives', {
      method: 'POST',
      json: { title: 'Root', level: 'goal' },
    });
    expect(res.status).toBe(201);
    expect(res.body.objective.level).toBe('objective'); // childless leaf, regardless of client
  });

  it('nesting builds the hierarchy bottom-up: leaf=objective, parent=project, root=goal', async () => {
    const g = await api(srv.url, '/api/objectives', { method: 'POST', json: { title: 'Goal' } });
    const p = await api(srv.url, '/api/objectives', { method: 'POST', json: { title: 'Project', parent_id: g.body.objective.id } });
    const m = await api(srv.url, '/api/objectives', { method: 'POST', json: { title: 'Objective', parent_id: p.body.objective.id } });
    expect(m.body.objective.level).toBe('objective'); // the leaf
    // Adding descendants re-levels the ancestors: verify the whole chain.
    expect(await levelOf(p.body.objective.id)).toBe('project');
    expect(await levelOf(g.body.objective.id)).toBe('goal');
  });

  it('422 when title is missing', async () => {
    const res = await api(srv.url, '/api/objectives', { method: 'POST', json: {} });
    expect(res.status).toBe(422);
  });

  it('422 when parent_id does not exist', async () => {
    const res = await api(srv.url, '/api/objectives', {
      method: 'POST',
      json: { title: 'Orphan', parent_id: 'nonexistent-id' },
    });
    expect(res.status).toBe(422);
  });

  it('422 for a cycle: self-parent rejected', async () => {
    const obj = await api(srv.url, '/api/objectives', { method: 'POST', json: { title: 'Self' } });
    const id = obj.body.objective.id;
    const res = await api(srv.url, `/api/objectives/${id}`, {
      method: 'PATCH',
      json: { parent_id: id },
    });
    expect(res.status).toBe(422);
  });
});

// ── PATCH /api/objectives/:id ──────────────────────────────────────────────────

describe('PATCH /api/objectives/:id', () => {
  it('updates title, horizon, status, target_date', async () => {
    const id = insertObjective({ title: 'Old title' });
    const res = await api(srv.url, `/api/objectives/${id}`, {
      method: 'PATCH',
      json: { title: 'New title', horizon: 'quarter', status: 'paused', target_date: '2027-01-01' },
    });
    expect(res.status).toBe(200);
    const obj = res.body.objective;
    expect(obj.title).toBe('New title');
    expect(obj.horizon).toBe('quarter');
    expect(obj.status).toBe('paused');
    expect(obj.target_date).toBe('2027-01-01');
  });

  it('re-levels on re-parent: detaching a lone child makes it (and the ex-parent) a leaf objective', async () => {
    const root = insertObjective({ title: 'Root goal' });
    const child = insertObjective({ title: 'Was child', parent_id: root });
    // Move child to top-level (no parent). A childless node is a leaf → 'objective'.
    const res = await api(srv.url, `/api/objectives/${child}`, { method: 'PATCH', json: { parent_id: null } });
    expect(res.status).toBe(200);
    expect(res.body.objective.level).toBe('objective');
    // The ex-parent lost its only child → it too is now a leaf objective.
    const root2 = sqlite.prepare(`SELECT level FROM objectives WHERE id = ?`).get(root) as { level: string };
    expect(root2.level).toBe('objective');
  });

  it('404 for unknown id', async () => {
    const res = await api(srv.url, '/api/objectives/nonexistent', { method: 'PATCH', json: { title: 'X' } });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/objectives/:id ─────────────────────────────────────────────────

describe('DELETE /api/objectives/:id', () => {
  it('deletes the objective and cascades to objective_tasks', async () => {
    const id = insertObjective({ title: 'To delete' });
    const t = insertTask('linked task');
    linkTask(id, t);
    const countBefore = (sqlite.prepare(`SELECT COUNT(*) AS n FROM objective_tasks WHERE objective_id = ?`).get(id) as { n: number }).n;
    expect(countBefore).toBe(1);

    const res = await api(srv.url, `/api/objectives/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const objCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM objectives WHERE id = ?`).get(id) as { n: number }).n;
    const linkCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM objective_tasks WHERE objective_id = ?`).get(id) as { n: number }).n;
    expect(objCount).toBe(0);
    expect(linkCount).toBe(0);
  });

  it('404 for unknown id', async () => {
    const res = await api(srv.url, '/api/objectives/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

// ── Task linking ───────────────────────────────────────────────────────────────

describe('POST /api/objectives/:id/tasks', () => {
  it('links a task to an objective', async () => {
    const oId = insertObjective({ title: 'Fitness goal' });
    const tId = insertTask('Run 5k');
    const res = await api(srv.url, `/api/objectives/${oId}/tasks`, {
      method: 'POST',
      json: { task_id: tId },
    });
    expect(res.status).toBe(201);
    const count = (sqlite.prepare(`SELECT COUNT(*) AS n FROM objective_tasks WHERE objective_id = ? AND task_id = ?`).get(oId, tId) as { n: number }).n;
    expect(count).toBe(1);
  });

  it('a task can be linked to multiple objectives', async () => {
    const o1 = insertObjective({ title: 'Goal A' });
    const o2 = insertObjective({ title: 'Goal B' });
    const t = insertTask('Shared task');
    await api(srv.url, `/api/objectives/${o1}/tasks`, { method: 'POST', json: { task_id: t } });
    await api(srv.url, `/api/objectives/${o2}/tasks`, { method: 'POST', json: { task_id: t } });
    const count = (sqlite.prepare(`SELECT COUNT(*) AS n FROM objective_tasks WHERE task_id = ?`).get(t) as { n: number }).n;
    expect(count).toBe(2);
  });

  it('idempotent — linking same task twice does not duplicate', async () => {
    const oId = insertObjective({ title: 'Idempotency test' });
    const tId = insertTask('Do the thing');
    await api(srv.url, `/api/objectives/${oId}/tasks`, { method: 'POST', json: { task_id: tId } });
    const res = await api(srv.url, `/api/objectives/${oId}/tasks`, { method: 'POST', json: { task_id: tId } });
    expect(res.status).toBe(201);
    const count = (sqlite.prepare(`SELECT COUNT(*) AS n FROM objective_tasks WHERE objective_id = ?`).get(oId) as { n: number }).n;
    expect(count).toBe(1);
  });

  it('404 when objective does not exist', async () => {
    const t = insertTask('Task');
    const res = await api(srv.url, '/api/objectives/nonexistent/tasks', { method: 'POST', json: { task_id: t } });
    expect(res.status).toBe(404);
  });

  it('422 when linking a task to a non-leaf objective (tasks live only at leaves)', async () => {
    // A parent with a child is a 'project' (height 1) — not a valid task home.
    const parent = insertObjective({ title: 'Project' });
    insertObjective({ title: 'Leaf', parent_id: parent });
    const t = insertTask('Misplaced');
    const res = await api(srv.url, `/api/objectives/${parent}/tasks`, { method: 'POST', json: { task_id: t } });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/objectives/:id/tasks/:taskId', () => {
  it('unlinks a task', async () => {
    const oId = insertObjective({ title: 'Fitness goal' });
    const tId = insertTask('Run 5k');
    linkTask(oId, tId);
    const res = await api(srv.url, `/api/objectives/${oId}/tasks/${tId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const count = (sqlite.prepare(`SELECT COUNT(*) AS n FROM objective_tasks WHERE objective_id = ? AND task_id = ?`).get(oId, tId) as { n: number }).n;
    expect(count).toBe(0);
  });

  it('idempotent — unlinking a task that was not linked returns 200', async () => {
    const oId = insertObjective({ title: 'Goal' });
    const tId = insertTask('Task');
    const res = await api(srv.url, `/api/objectives/${oId}/tasks/${tId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});

// ── Rollup — progress_cache ────────────────────────────────────────────────────

describe('progress_cache rollup', () => {
  it('NULL when objective has no linked tasks and no children', async () => {
    const id = insertObjective({ title: 'Empty' });
    const res = await api(srv.url, '/api/objectives');
    expect(res.body.objectives.find((o: any) => o.id === id).progress_cache).toBeNull();
  });

  it('estimate-weighted completion when all tasks have estimates', async () => {
    const id = insertObjective({ title: 'With tasks' });
    const t1 = insertTask('Task A', 60, 'done');   // 60 min, done
    const t2 = insertTask('Task B', 40, 'open');   // 40 min, open
    linkTask(id, t1);
    linkTask(id, t2);
    // Trigger recompute by patching to flush
    await api(srv.url, `/api/objectives/${id}/recompute`, { method: 'POST' });
    const res = await api(srv.url, '/api/objectives');
    const obj = res.body.objectives.find((o: any) => o.id === id);
    // done_est = 60, total_est = 100 → 0.6
    expect(obj.progress_cache).toBeCloseTo(0.6, 2);
  });

  it('count-based fallback when tasks have no estimates', async () => {
    const id = insertObjective({ title: 'No estimates' });
    const t1 = insertTask('T1', undefined, 'done');
    const t2 = insertTask('T2', undefined, 'open');
    const t3 = insertTask('T3', undefined, 'open');
    linkTask(id, t1);
    linkTask(id, t2);
    linkTask(id, t3);
    await api(srv.url, `/api/objectives/${id}/recompute`, { method: 'POST' });
    const res = await api(srv.url, '/api/objectives');
    const obj = res.body.objectives.find((o: any) => o.id === id);
    // 1 of 3 done → 0.333
    expect(obj.progress_cache).toBeCloseTo(1 / 3, 2);
  });

  it('NULL when no tasks linked (even after recompute)', async () => {
    const id = insertObjective({ title: 'Ghost' });
    await api(srv.url, `/api/objectives/${id}/recompute`, { method: 'POST' });
    const res = await api(srv.url, '/api/objectives');
    expect(res.body.objectives.find((o: any) => o.id === id).progress_cache).toBeNull();
  });
});

// ── advance_objectives job ─────────────────────────────────────────────────────

describe('advance_objectives', () => {
  it('nominates next-action task into flight_plan with source_kind=objective', async () => {
    const oId = insertObjective({ title: 'Weekly obj', cadence: 'weekly', last_advanced_at: LONG_AGO });
    const tId = insertTask('Write first draft');
    linkTask(oId, tId);

    advanceObjectives(SYSTEM_OWNER, { now: NOW });

    const rows = fpRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe(tId);
    expect(rows[0].source_kind).toBe('objective');
    expect(rows[0].source_ref).toBe(oId);
  });

  it('UPSERT: repoints an already-staged task (was pattern, now objective)', async () => {
    const oId = insertObjective({ title: 'Reclaim task', cadence: 'weekly', last_advanced_at: LONG_AGO });
    const tId = insertTask('Staged from pattern');
    linkTask(oId, tId);

    // Pre-stage the task as if it came from a pattern.
    sqlite.prepare(
      `INSERT INTO flight_plan (owner_id, task_id, source_kind, source_ref, selected, position, added_at)
       VALUES (?, ?, 'pattern', 'some-pattern-id', 1, 0, ?)`
    ).run(SYSTEM_OWNER, tId, NOW);

    advanceObjectives(SYSTEM_OWNER, { now: NOW });

    const rows = fpRows();
    // Still exactly 1 row — the UPSERT repointed, not duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0].source_kind).toBe('objective');
    expect(rows[0].source_ref).toBe(oId);
  });

  it('idempotent: second run within the same period is a no-op', async () => {
    // last_advanced_at set to today → within the weekly window → skip.
    const recentlyAdvanced = '2026-06-14T12:00:00.000Z'; // yesterday, within 7 days
    const oId = insertObjective({ title: 'Already advanced', cadence: 'weekly', last_advanced_at: recentlyAdvanced });
    const tId = insertTask('Do work');
    linkTask(oId, tId);

    advanceObjectives(SYSTEM_OWNER, { now: NOW });

    expect(fpRows()).toHaveLength(0); // skipped due to anti-thrash gate
  });

  it('skips paused objectives', async () => {
    const oId = insertObjective({ title: 'Paused', cadence: 'weekly', status: 'paused', last_advanced_at: LONG_AGO });
    const tId = insertTask('Paused task');
    linkTask(oId, tId);
    advanceObjectives(SYSTEM_OWNER, { now: NOW });
    expect(fpRows()).toHaveLength(0);
  });

  it('skips done objectives', async () => {
    const oId = insertObjective({ title: 'Done', cadence: 'weekly', status: 'done', last_advanced_at: LONG_AGO });
    const tId = insertTask('Done task');
    linkTask(oId, tId);
    advanceObjectives(SYSTEM_OWNER, { now: NOW });
    expect(fpRows()).toHaveLength(0);
  });

  it('skips objectives with cadence=none', async () => {
    const oId = insertObjective({ title: 'No cadence', cadence: 'none', last_advanced_at: LONG_AGO });
    const tId = insertTask('Task');
    linkTask(oId, tId);
    advanceObjectives(SYSTEM_OWNER, { now: NOW });
    expect(fpRows()).toHaveLength(0);
  });

  it('no next action → does not add to flight_plan', async () => {
    // All linked tasks are done → no next action → nothing nominated.
    const oId = insertObjective({ title: 'All done', cadence: 'weekly', last_advanced_at: LONG_AGO });
    const tId = insertTask('Completed task', undefined, 'done');
    linkTask(oId, tId);
    advanceObjectives(SYSTEM_OWNER, { now: NOW });
    expect(fpRows()).toHaveLength(0);
  });

  it('skips if next_action task is already in_progress', async () => {
    const oId = insertObjective({ title: 'In progress obj', cadence: 'weekly', last_advanced_at: LONG_AGO });
    const tId = insertTask('In progress task', undefined, 'open');
    linkTask(oId, tId);

    // Simulate "in progress" by staging the task already; set status to in_progress via direct SQL.
    sqlite.prepare(
      `INSERT INTO flight_plan (owner_id, task_id, source_kind, selected, position, added_at)
       VALUES (?, ?, 'manual', 1, 0, ?)`
    ).run(SYSTEM_OWNER, tId, NOW);
    sqlite.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(tId);

    advanceObjectives(SYSTEM_OWNER, { now: NOW });

    // Row count unchanged — the task was already staged AND in_progress: no new nomination.
    expect(fpRows()).toHaveLength(1);
    expect(fpRows()[0].source_kind).toBe('manual'); // not overwritten
  });

  it('bumps last_advanced_at after successful nomination', async () => {
    const oId = insertObjective({ title: 'Advance me', cadence: 'weekly', last_advanced_at: LONG_AGO });
    const tId = insertTask('Next action');
    linkTask(oId, tId);

    advanceObjectives(SYSTEM_OWNER, { now: NOW });

    const row = sqlite.prepare(`SELECT last_advanced_at FROM objectives WHERE id = ?`).get(oId) as { last_advanced_at: string };
    expect(row.last_advanced_at).not.toBe(LONG_AGO);
  });
});

// ── flight_plan source_kind/source_ref (rework) ───────────────────────────────

describe('flight_plan source rework', () => {
  it('staging via pattern API sets source_kind=pattern, source_ref=pattern_id', async () => {
    const ht = sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND owner_id = ?`).get(SYSTEM_OWNER) as { id: string };
    const pid = (sqlite.prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, 'Test pattern') RETURNING id`).get(SYSTEM_OWNER, ht.id) as { id: string }).id;
    const tId = insertTask('Pattern task');
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`).run(pid, tId);

    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { pattern_id: pid } });

    const rows = fpRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source_kind).toBe('pattern');
    expect(rows[0].source_ref).toBe(pid);
  });

  it('staging a task directly sets source_kind=manual', async () => {
    const tId = insertTask('Direct task');
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: tId } });
    const rows = fpRows();
    expect(rows[0].source_kind).toBe('manual');
    expect(rows[0].source_ref).toBeNull();
  });
});
