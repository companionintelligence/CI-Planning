import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { classifyMotivationKeyword, classifyMotivationLLM, applyMachineMotivation } from '../src/services/motivation.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Triality T2b — the motivation axis (0141, design §3b).
 *
 * The core correctness rule under test everywhere here: NULL (unlabeled) and
 * 'us' (shared benefit) are different facts and must never blur — plus the
 * LLM-first guardrails: unsure ⇒ null, never guess 'us', machine labels are
 * fill-blanks-only, and a user label wins permanently.
 */

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});
beforeEach(() => {
  resetDb();
});

describe('migration 0141', () => {
  it('is idempotent and leaves existing rows unlabeled (NULL, not us)', () => {
    const mig = MIGRATIONS.find((m) => m.id === '0141_task_motivation');
    expect(mig).toBeTruthy();
    mig!.up(sqlite as never);
    const cols = sqlite.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    expect(cols.filter((c) => c.name === 'motivation')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'motivation_source')).toHaveLength(1);

    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'pre-axis', ?, 'open')`)
      .run(SYSTEM_OWNER);
    const row = sqlite
      .prepare(`SELECT motivation, motivation_source FROM tasks WHERE title = 'pre-axis'`)
      .get() as { motivation: string | null; motivation_source: string | null };
    expect(row.motivation).toBeNull();
    expect(row.motivation_source).toBeNull();
  });
});

describe('route validation + source stamping', () => {
  it('accepts me/us/them/null and 422s junk on POST', async () => {
    for (const v of ['me', 'us', 'them']) {
      const res = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: `t-${v}`, motivation: v } });
      expect(res.status).toBe(201);
      expect(res.body.task.motivation).toBe(v);
      expect(res.body.task.motivation_source).toBe('user');
    }
    const nullRes = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'buy milk', motivation: null } });
    expect(nullRes.status).toBe(201);

    const junk = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'x', motivation: 'both' } });
    expect(junk.status).toBe(422);
  });

  it('ignores a client-claimed motivation_source (server-derived only)', async () => {
    const res = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'spoofed source', motivation: 'me', motivation_source: 'llm' },
    });
    expect(res.status).toBe(201);
    expect(res.body.task.motivation_source).toBe('user');
  });

  it('PATCH stamps user, and explicit null clears BOTH columns', async () => {
    const created = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'flip me' } });
    const id = created.body.task.id;

    const set = await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { motivation: 'us' } });
    expect(set.status).toBe(200);
    expect(set.body.task.motivation).toBe('us');
    expect(set.body.task.motivation_source).toBe('user');

    const cleared = await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { motivation: null } });
    expect(cleared.body.task.motivation).toBeNull();
    expect(cleared.body.task.motivation_source).toBeNull();

    const junk = await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { motivation: 'ME' } });
    expect(junk.status).toBe(422); // vocabulary is lowercase on the wire — enums live in GraphQL
  });
});

describe('deterministic keyword fallback (never us, unsure ⇒ null)', () => {
  it('classifies clear signals and refuses ambiguity', () => {
    expect(classifyMotivationKeyword('help mom with her taxes')).toBe('them');
    expect(classifyMotivationKeyword('volunteering at the shelter saturday')).toBe('them');
    expect(classifyMotivationKeyword('study for the exam so mom stops worrying')).toBe('them');
    expect(classifyMotivationKeyword('outline my own career plan')).toBe('me');
    expect(classifyMotivationKeyword('buy milk')).toBeNull();
    expect(classifyMotivationKeyword('quarterly report')).toBeNull();
  });

  it('rides createTask inline: an unlabeled create gets a machine label', async () => {
    const res = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'help mom with her taxes' } });
    expect(res.status).toBe(201);
    expect(res.body.task.motivation).toBe('them');
    expect(res.body.task.motivation_source).toBe('llm'); // machine-attributed, keyword or model
  });

  it('quick-add without Ollama still lands the keyword label', async () => {
    // enrichQuick throws in tests (no Ollama) → route keeps the deterministic parse;
    // the keyword pass inside createTask is what fires here.
    const res = await api(srv.url, '/api/tasks/quick', { method: 'POST', json: { text: 'volunteer at the food bank friday' } });
    expect(res.status).toBe(201);
    expect(res.body.task.motivation).toBe('them');
    expect(res.body.task.motivation_source).toBe('llm');
  });
});

describe('LLM classifier (injected fake — the possibles.ts embedFn idiom)', () => {
  it('stores a valid answer, nulls junk, nulls refusals', async () => {
    expect(await classifyMotivationLLM('t', null, async () => ({ motivation: 'them' }))).toBe('them');
    expect(await classifyMotivationLLM('t', null, async () => ({ motivation: 'both of us' }))).toBeNull();
    expect(await classifyMotivationLLM('t', null, async () => ({ motivation: 42 }))).toBeNull();
    expect(await classifyMotivationLLM('t', null, async () => 'I cannot classify this task.')).toBeNull();
    expect(await classifyMotivationLLM('t', null, async () => null)).toBeNull();
  });
});

describe('never-re-tag contract', () => {
  it('applyMachineMotivation fills blanks only — user and prior machine labels stand', async () => {
    const userSet = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'mine', motivation: 'me' } });
    const userId = userSet.body.task.id;
    expect(await applyMachineMotivation(SYSTEM_OWNER, userId, 'them')).toBe(false);

    const blank = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'unlabeled thing' } });
    const blankId = blank.body.task.id;
    expect(await applyMachineMotivation(SYSTEM_OWNER, blankId, 'us')).toBe(true);
    expect(await applyMachineMotivation(SYSTEM_OWNER, blankId, 'them')).toBe(false); // second pass no-ops

    const row = sqlite
      .prepare(`SELECT motivation, motivation_source FROM tasks WHERE id = ?`)
      .get(blankId) as { motivation: string; motivation_source: string };
    expect(row.motivation).toBe('us');
    expect(row.motivation_source).toBe('llm');
  });

  it('is owner-scoped — another owner cannot be machine-tagged across tenants', async () => {
    const t = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'not yours' } });
    expect(await applyMachineMotivation('some-other-owner', t.body.task.id, 'me')).toBe(false);
  });
});
