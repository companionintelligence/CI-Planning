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

const plan = (text: string) => api<{ reply: string; actions: unknown[] }>(server.url, '/api/task-agent/plan', { method: 'POST', json: { text } });

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

  it('rejects an empty request before invoking the model', async () => {
    const response = await plan('  ');
    expect(response.status).toBe(422);
    expect(model).not.toHaveBeenCalled();
  });
});
