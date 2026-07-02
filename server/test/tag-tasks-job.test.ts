import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { taskTagNames } from '../src/services/tags.js';
import { tagUntaggedTasks, tagTitleFallback } from '../src/services/auto-tag.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;

function insertTask(title: string, extra?: { parentId?: string; recurrenceParentId?: string; status?: string }): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority, parent_id, recurrence_parent_id)
         VALUES (uuid7(), ?, ?, ?, 30, 3, ?, ?) RETURNING id`,
      )
      .get(
        title,
        OWNER,
        extra?.status ?? 'open',
        extra?.parentId ?? null,
        extra?.recurrenceParentId ?? null,
      ) as { id: string }
  ).id;
}

function seedTag(name: string): string {
  sqlite.prepare(`INSERT OR IGNORE INTO tags (id, name, owner_id) VALUES (uuid7(), ?, ?)`).run(name, OWNER);
  return (sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as { id: string }).id;
}

function applyTag(taskId: string, tagId: string): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`)
    .run(taskId, tagId);
}

// ── tagTitleFallback (server-side heuristic) ────────────────────────────────

describe('tagTitleFallback', () => {
  const vocab = ['email', 'finance', 'deep-work', 'errands'];

  it('matches whole words, not substrings', () => {
    expect(tagTitleFallback('Email Rek about FINANCE', vocab).sort()).toEqual(['email', 'finance']);
    expect(tagTitleFallback('emailing the team', vocab)).toEqual([]);
  });

  it('matches hyphenated tags as phrase or hyphenated', () => {
    expect(tagTitleFallback('Deep work session', vocab)).toContain('deep-work');
    expect(tagTitleFallback('deep-work block', vocab)).toContain('deep-work');
  });

  it('returns nothing when no tag appears', () => {
    expect(tagTitleFallback('Walk the dog', vocab)).toEqual([]);
    expect(tagTitleFallback('', vocab)).toEqual([]);
  });
});

// ── tagUntaggedTasks ─────────────────────────────────────────────────────────

describe('tagUntaggedTasks', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('tags an untagged task using the heuristic fallback (Ollama unavailable in tests)', async () => {
    seedTag('email');
    const t = insertTask('Send email to Rek');

    const result = await tagUntaggedTasks(OWNER);

    expect(result.total).toBe(1);
    expect(result.tagged).toBe(1);
    expect(taskTagNames(t)).toContain('email');
  });

  it('skips tasks that already have tags — does not overwrite or remove them', async () => {
    const financeId = seedTag('finance');
    const tagged = insertTask('Review finance report');
    applyTag(tagged, financeId);

    const result = await tagUntaggedTasks(OWNER);

    // Already-tagged task is not in the untagged set
    expect(result.total).toBe(0);
    expect(taskTagNames(tagged)).toEqual(['finance']); // unchanged
  });

  it('is idempotent: running twice does not duplicate tags', async () => {
    seedTag('email');
    const t = insertTask('Email Rek about the invoice');

    await tagUntaggedTasks(OWNER);
    expect(taskTagNames(t)).toEqual(['email']);

    // Second run: task now has tags → NOT EXISTS excludes it → no-op
    const second = await tagUntaggedTasks(OWNER);
    expect(second.total).toBe(0);
    expect(taskTagNames(t)).toEqual(['email']); // still exactly one copy
  });

  it('skips subtasks (parent_id set) and recurrence instances (recurrence_parent_id set)', async () => {
    const parentId = insertTask('Parent task');
    seedTag('email');
    insertTask('Email subtask', { parentId });
    insertTask('Recurring email', { recurrenceParentId: parentId });

    const result = await tagUntaggedTasks(OWNER);

    // Only the parent task is eligible; it doesn't match any tag
    expect(result.total).toBe(1); // parent only
  });

  it('skips done and cancelled tasks', async () => {
    seedTag('email');
    insertTask('Email done', { status: 'done' });
    insertTask('Email cancelled', { status: 'cancelled' });

    const result = await tagUntaggedTasks(OWNER);
    expect(result.total).toBe(0);
  });

  it('returns helpful log message when vocabulary is empty', async () => {
    insertTask('Email Rek'); // no tags seeded
    const result = await tagUntaggedTasks(OWNER);
    expect(result.tagged).toBe(0);
    expect(result.log).toMatch(/vocabulary/i);
  });
});

// ── tag_tasks job integration (via API) ─────────────────────────────────────

describe('tag_tasks scheduled job', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('appears in GET /api/jobs with the correct cron expression', async () => {
    const res = await api(srv.url, '/api/jobs');
    expect(res.status).toBe(200);
    const job = (res.body.jobs as { kind: string; cron: string; id: string }[]).find(
      (j) => j.kind === 'tag_tasks',
    );
    expect(job).toBeTruthy();
    expect(job!.cron).toBe('0 * * * *'); // hourly
  });

  it('can be triggered via POST /api/jobs/:id/run and updates items_updated', async () => {
    seedTag('email');
    insertTask('Email Rek about the project');

    const listRes = await api(srv.url, '/api/jobs');
    const job = (listRes.body.jobs as { kind: string; id: string }[]).find((j) => j.kind === 'tag_tasks')!;

    const runRes = await api(srv.url, `/api/jobs/${job.id}/run`, { method: 'POST' });
    expect(runRes.status).toBe(200);

    // The run route is fire-and-forget: POST returns 200 immediately and the job
    // finishes in the background (clients learn of completion over SSE). Poll
    // GET /api/jobs until the run reaches a terminal status rather than assuming
    // it already finished — otherwise the read races the background job.
    let updated!: { kind: string; last_status: string; items_updated: number };
    for (let i = 0; i < 100; i++) {
      const after = await api(srv.url, '/api/jobs');
      updated = (after.body.jobs as { kind: string; last_status: string; items_updated: number }[]).find(
        (j) => j.kind === 'tag_tasks',
      )!;
      if (updated.last_status === 'done' || updated.last_status === 'error') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(updated.last_status).toBe('done');
    expect(updated.items_updated).toBe(1);
  });
});
