import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { taskTagNames, entityTagLevels } from '../src/services/tags.js';
import { tagUntaggedTasks, tagTitleFallback, mergeTags } from '../src/services/auto-tag.js';
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

// kind defaults to 'intention' (schema.ts) — pass 'direction' / 'category' explicitly to
// exercise the AF-11 leveling, which is keyed off the tag's kind.
function seedTag(name: string, kind = 'intention'): string {
  sqlite.prepare(`INSERT OR IGNORE INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, ?)`).run(name, OWNER, kind);
  return (sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as { id: string }).id;
}

/** Level-keyed view of a task's tags — the AF-11 split this sweep must reproduce. */
function levels(taskId: string): { l1: string[]; l2: string[] } {
  const rows = entityTagLevels('task', taskId);
  return {
    l1: rows.filter((r) => r.level === 1).map((r) => r.name),
    l2: rows.filter((r) => r.level === 2).map((r) => r.name),
  };
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

// ── mergeTags (LLM ∪ heuristic, vocabulary-constrained) ──────────────────────
// Ported from client/src/lib/tag-suggest.test.ts when the merge moved server-side.

describe('mergeTags', () => {
  const vocab = ['email', 'finance', 'deep-work', 'errands'];

  it('unions LLM + heuristic, dedupes, and preserves LLM-first order', () => {
    expect(mergeTags(['finance'], ['email', 'finance'], vocab)).toEqual(['finance', 'email']);
  });

  it('never lets a non-vocabulary tag through (no invented tags)', () => {
    expect(mergeTags(['made-up'], ['email'], vocab)).toEqual(['email']);
    expect(mergeTags(['made-up'], ['also-fake'], vocab)).toEqual([]);
  });

  it('degrades to the heuristic when the LLM list is empty (Ollama down)', () => {
    expect(mergeTags([], ['email', 'deep-work'], vocab)).toEqual(['email', 'deep-work']);
  });

  it('returns nothing when both are empty', () => {
    expect(mergeTags([], [], vocab)).toEqual([]);
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
    expect(result.taggedIds).toEqual([t]);
    expect(levels(t).l2).toContain('email'); // an intention lands at level 2
  });

  // AF-11 leveling — the split the Tasks Auto-tag button used to do client-side.
  it('levels by kind: one direction at level 1, intentions at level 2', async () => {
    seedTag('work', 'direction');
    seedTag('email');
    seedTag('finance');
    const t = insertTask('Work on the finance email');

    await tagUntaggedTasks(OWNER);

    expect(levels(t).l1).toEqual(['work']);
    expect(levels(t).l2.sort()).toEqual(['email', 'finance']);
  });

  it('keeps only the FIRST direction — a task has one primary direction', async () => {
    seedTag('work', 'direction');
    seedTag('home', 'direction');
    const t = insertTask('Work and home errands');

    await tagUntaggedTasks(OWNER);

    expect(levels(t).l1).toHaveLength(1);
    expect(levels(t).l2).toEqual([]); // the dropped direction is NOT demoted to level 2
  });

  it('never attaches a category tag (categories live in entity_categories)', async () => {
    seedTag('personal', 'category');
    const t = insertTask('Personal admin');

    const result = await tagUntaggedTasks(OWNER);

    expect(result.tagged).toBe(0);
    expect(entityTagLevels('task', t)).toEqual([]);
  });

  it('ignores muted tags', async () => {
    const id = seedTag('email');
    sqlite.prepare(`UPDATE tags SET muted = 1 WHERE id = ?`).run(id);
    const t = insertTask('Send email to Rek');

    const result = await tagUntaggedTasks(OWNER);

    expect(result.tagged).toBe(0);
    expect(entityTagLevels('task', t)).toEqual([]);
  });

  // The Auto-tag button passes the ids on screen so a filtered view tags only what the
  // user can see; the cron omits the argument and sweeps the whole owner.
  it('honours the taskIds scope, leaving out-of-scope tasks untouched', async () => {
    seedTag('email');
    const inScope = insertTask('Send email to Rek');
    const outOfScope = insertTask('Email the invoice');

    const result = await tagUntaggedTasks(OWNER, [inScope]);

    expect(result.total).toBe(1); // only the scoped task was even considered
    expect(levels(inScope).l2).toContain('email');
    expect(entityTagLevels('task', outOfScope)).toEqual([]);
  });

  it('treats an empty scope as "nothing selected", not owner-wide', async () => {
    seedTag('email');
    const t = insertTask('Send email to Rek');

    const result = await tagUntaggedTasks(OWNER, []);

    expect(result.total).toBe(0);
    expect(entityTagLevels('task', t)).toEqual([]);
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
    expect(levels(t).l2).toEqual(['email']);

    // Second run: task now has tags at SOME level → NOT EXISTS excludes it → no-op
    const second = await tagUntaggedTasks(OWNER);
    expect(second.total).toBe(0);
    expect(levels(t).l2).toEqual(['email']); // still exactly one copy
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

// ── POST /api/tasks/auto-tag (the Tasks view's Auto-tag button) ──────────────
// The route is a thin shell over the service above; these cover the HTTP contract
// (scoping + response shape), not the tagging rules.

describe('POST /api/tasks/auto-tag', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('tags the scoped tasks and reports counts', async () => {
    seedTag('work', 'direction');
    const scoped = insertTask('Work on the report');
    const other = insertTask('Work on the deck');

    const { status, body } = await api(srv.url, '/api/tasks/auto-tag', {
      method: 'POST',
      json: { task_ids: [scoped] },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ tagged: 1, total: 1 });
    expect(levels(scoped).l1).toEqual(['work']);
    expect(entityTagLevels('task', other)).toEqual([]);
  });

  it('sweeps the whole owner when task_ids is omitted (the cron\'s scope)', async () => {
    seedTag('work', 'direction');
    const a = insertTask('Work on the report');
    const b = insertTask('Work on the deck');

    const { body } = await api(srv.url, '/api/tasks/auto-tag', { method: 'POST', json: {} });

    expect(body.tagged).toBe(2);
    expect(levels(a).l1).toEqual(['work']);
    expect(levels(b).l1).toEqual(['work']);
  });

  it('ignores a non-array task_ids rather than 500ing', async () => {
    seedTag('work', 'direction');
    const t = insertTask('Work on the report');

    const { status, body } = await api(srv.url, '/api/tasks/auto-tag', {
      method: 'POST',
      json: { task_ids: 'nope' },
    });

    expect(status).toBe(200);
    expect(body.tagged).toBe(1); // fell back to owner-wide
    expect(levels(t).l1).toEqual(['work']);
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
