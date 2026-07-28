import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { enrichTaskFromMemory, enrichRecentTasks } from '../src/services/task-enrich.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;

function insertTask(title: string, notes: string | null = null): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority, notes)
         VALUES (uuid7(), ?, ?, 'open', 30, 3, ?) RETURNING id`,
      )
      .get(title, OWNER, notes) as { id: string }
  ).id;
}

// MEMORY_MODE is unset in tests ⇒ the connector reports 'off'. That is the case worth
// pinning hardest: the feature must be a silent, honest no-op on every deployment that
// never configures memory — which is all of them by default.

describe('enrichTaskFromMemory · memory off', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('no-ops with an explicit reason rather than failing or inventing', async () => {
    const id = insertTask('Ship the release');
    const r = await enrichTaskFromMemory(OWNER, id);
    expect(r.enriched).toBe(false);
    expect(r.reason).toMatch(/memory is off/i);
  });

  it('writes nothing to the task', async () => {
    const id = insertTask('Ship the release');
    await enrichTaskFromMemory(OWNER, id);
    const row = sqlite.prepare('SELECT notes FROM tasks WHERE id = ?').get(id) as { notes: string | null };
    expect(row.notes).toBeNull();
    const tags = sqlite.prepare(`SELECT COUNT(*) n FROM entity_tags WHERE entity_id = ?`).get(id) as { n: number };
    expect(tags.n).toBe(0);
  });

  it('reports a missing task rather than throwing', async () => {
    const r = await enrichTaskFromMemory(OWNER, 'does-not-exist');
    // Memory-off is checked first, so either honest reason is acceptable — the contract
    // is "never throws, always explains".
    expect(r.enriched).toBe(false);
    expect(typeof r.reason).toBe('string');
  });

  it('the nightly sweep skips honestly and does no work', async () => {
    insertTask('Ship the release');
    const r = await enrichRecentTasks(OWNER);
    expect(r).toMatchObject({ enriched: 0, considered: 0 });
    expect(r.log).toMatch(/memory is off/i);
  });
});

// ── HTTP surfaces ────────────────────────────────────────────────────────────

describe('POST /api/tasks/:id/enrich', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('404s an unknown task', async () => {
    const { status } = await api(srv.url, '/api/tasks/nope/enrich', { method: 'POST', json: {} });
    expect(status).toBe(404);
  });

  it('answers 200 with enriched:false + reason when memory is off', async () => {
    const id = insertTask('Ship the release');
    const { status, body } = await api(srv.url, `/api/tasks/${id}/enrich`, { method: 'POST', json: {} });
    expect(status).toBe(200);
    expect(body.enriched).toBe(false);
    expect(body.reason).toMatch(/memory is off/i);
  });
});

describe('POST /api/tasks/suggest-subtasks', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('returns an array and CREATES NOTHING (D5 — suggest-only)', async () => {
    const before = (sqlite.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
    const { status, body } = await api(srv.url, '/api/tasks/suggest-subtasks', {
      method: 'POST',
      json: { title: 'Plan a week-long trip to Japan' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.subtasks)).toBe(true);
    // The invariant that matters: no task row appeared, whatever the model said (and with
    // Ollama down the array is simply empty).
    const after = (sqlite.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('handles a missing title without erroring', async () => {
    const { status, body } = await api(srv.url, '/api/tasks/suggest-subtasks', { method: 'POST', json: {} });
    expect(status).toBe(200);
    expect(body.subtasks).toEqual([]);
  });
});
