import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { api, resetDb, startTestServer, type TestServer } from './helpers.js';

const model = vi.hoisted(() => vi.fn());
vi.mock('../src/mcp/ollama.js', async (original) => ({
  ...(await original<typeof import('../src/mcp/ollama.js')>()),
  generateJson: model,
}));

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { await server.close(); });
beforeEach(() => { resetDb(); model.mockReset(); });

const plan = (text: string, screen?: unknown) => api<{ reply: string; actions: unknown[] }>(server.url, '/api/task-agent/plan', { method: 'POST', json: { text, screen } });

describe('task agent proposals', () => {
  it('proposes an owned task update without writing it', async () => {
    sqlite.prepare("INSERT INTO tasks (id, title, owner_id, status) VALUES ('agent-task', 'Call Sam', ?, 'open')").run(SYSTEM_OWNER);
    model.mockResolvedValue({ reply: 'I can move Call Sam to Friday.', actions: [{ kind: 'update_task', task_id: 'agent-task', scheduled_for: '2026-11-27' }] });
    const response = await plan('Move Call Sam to Friday');
    expect(response.status).toBe(200);
    expect(response.body.actions).toEqual([{ kind: 'update_task', task_id: 'agent-task', scheduled_for: '2026-11-27' }]);
    expect(sqlite.prepare("SELECT scheduled_for FROM tasks WHERE id = 'agent-task'").get()).toMatchObject({ scheduled_for: null });
  });

  it('rejects invented task IDs and invalid dates', async () => {
    model.mockResolvedValue({ reply: 'Done.', actions: [{ kind: 'update_task', task_id: 'other-owner-task', scheduled_for: '2026-02-31' }] });
    const response = await plan('Move a task');
    expect(response.status).toBe(200);
    expect(response.body.actions).toEqual([]);
    expect(response.body.reply).toMatch(/could not match/i);
  });

  it('does not turn a move into an extra objective link when the source is missing', async () => {
    sqlite.prepare("INSERT INTO tasks (id, title, owner_id, status) VALUES ('agent-task', 'Call Sam', ?, 'open')").run(SYSTEM_OWNER);
    sqlite.prepare("INSERT INTO objectives (id, owner_id, title, created_at, updated_at) VALUES ('from-objective', ?, 'Current', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), ('to-objective', ?, 'Next', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(SYSTEM_OWNER, SYSTEM_OWNER);
    sqlite.prepare("INSERT INTO objective_tasks (objective_id, task_id) VALUES ('from-objective', 'agent-task')").run();
    model.mockResolvedValue({ reply: 'I can move it.', actions: [{ kind: 'move_task', task_id: 'agent-task', target_objective_id: 'to-objective' }] });
    const response = await plan('Move Call Sam to Next');
    expect(response.body.actions).toEqual([]);
  });

  it('proposes a note and draft fields without writing either', async () => {
    sqlite.prepare("INSERT INTO tasks (id, title, owner_id, status) VALUES ('agent-task', 'Call Sam', ?, 'open')").run(SYSTEM_OWNER);
    model.mockResolvedValue({ reply: 'I can add that note.', actions: [{ kind: 'add_note', task_id: 'agent-task', body: 'Discuss Friday' }, { kind: 'draft_task', task_id: 'agent-task', priority: 1 }] });
    const response = await plan('Add a note to Call Sam and suggest high priority');
    expect(response.body.actions).toEqual([{ kind: 'add_note', task_id: 'agent-task', body: 'Discuss Friday' }, { kind: 'draft_task', task_id: 'agent-task', priority: 1 }]);
    expect(sqlite.prepare("SELECT count(*) AS count FROM task_notes WHERE task_id = 'agent-task'").get()).toMatchObject({ count: 0 });
  });

  it('appends multiple timestamped notes and keeps them owner scoped', async () => {
    sqlite.prepare("INSERT INTO tasks (id, title, owner_id, status) VALUES ('agent-task', 'Call Sam', ?, 'open')").run(SYSTEM_OWNER);
    for (const body of ['First', 'Second']) {
      const response = await api(server.url, '/api/task-agent/tasks/agent-task/notes', { method: 'POST', json: { body } });
      expect(response.status).toBe(201);
    }
    const response = await api<{ notes: Array<{ body: string; created_at: string }> }>(server.url, '/api/task-agent/tasks/agent-task/notes');
    expect(response.body.notes).toHaveLength(2);
    expect(response.body.notes.map((note) => note.body)).toEqual(expect.arrayContaining(['First', 'Second']));
    expect(response.body.notes.every((note) => !Number.isNaN(Date.parse(note.created_at)))).toBe(true);
    expect((await api(server.url, '/api/task-agent/tasks/no-such-task/notes')).status).toBe(404);
  });

  it('rejects an empty request before invoking the model', async () => {
    const response = await plan('  ');
    expect(response.status).toBe(422);
    expect(model).not.toHaveBeenCalled();
  });

  it('reports an archived task state outside the recent task window', async () => {
    sqlite.prepare("INSERT INTO tasks (id, title, owner_id, status, priority, created_at) VALUES ('old-task', 'File tax return', ?, 'done', 1, '2020-01-01')").run(SYSTEM_OWNER);
    const insert = sqlite.prepare("INSERT INTO tasks (id, title, owner_id, status) VALUES (?, 'Filler', ?, 'open')");
    for (let i = 0; i < 210; i++) insert.run(`filler-${i}`, SYSTEM_OWNER);
    const response = await plan('What is the status of File tax return?');
    expect(response.body.reply).toContain('“File tax return” is done');
    expect(response.body.actions).toEqual([]);
    expect(model).not.toHaveBeenCalled();
  });

  it('recaps owner metrics from data without asking the model', async () => {
    const response = await plan('Recap my metrics this week');
    expect(response.status).toBe(200);
    expect(response.body.reply).toContain('Over the last 7 days:');
    expect(response.body.reply).toContain('currently open');
    expect(model).not.toHaveBeenCalled();
  });

  it('reports the current screen and selected task from semantic context', async () => {
    sqlite.prepare("INSERT INTO tasks (id, title, owner_id, status) VALUES ('agent-task', 'Call Sam', ?, 'scheduled')").run(SYSTEM_OWNER);
    const response = await plan('What is on this screen?', { path: '/balance', tab: 'metrics', selectedTaskId: 'agent-task', headings: ['Life Balance', 'Metrics'] });
    expect(response.body.reply).toContain('/balance, metrics tab');
    expect(response.body.reply).toContain('Selected task: “Call Sam” is scheduled');
    expect(model).not.toHaveBeenCalled();
  });
});
