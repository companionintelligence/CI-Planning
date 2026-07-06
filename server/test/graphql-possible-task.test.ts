import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W9 — PossibleTaskType end-to-end over HTTP. Proves the `possibleTasks`/
 * `possibleTask` queries + promote/dismiss mutations reuse the SAME services/possibles.ts
 * the REST routes use (cross-checked via REST GET), the promote tag-carry + status flip,
 * SSE parity (possible:promoted/dismissed), REST-shape parity, and cross-owner isolation
 * on BOTH reads and writes (the service scopes by proposed_owner_id).
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  return { status: res.status, body };
}

/** Seed a possible task owned (proposed) by `owner`. Returns its id. */
function insertPossible(
  rawTitle: string,
  owner = OWNER,
  opts: { status?: string; rawSummary?: string | null; proposedDueAt?: string | null; proposedPriority?: number | null; sourceKind?: string | null; sourceRef?: string | null; confidence?: number | null } = {},
): string {
  return (sqlite
    .prepare(
      `INSERT INTO possible_tasks (id, raw_title, raw_summary, proposed_due_at, proposed_priority, proposed_owner_id, source_kind, source_ref, confidence, status)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      rawTitle,
      opts.rawSummary ?? null,
      opts.proposedDueAt ?? null,
      opts.proposedPriority ?? null,
      owner,
      opts.sourceKind ?? null,
      opts.sourceRef ?? null,
      opts.confidence ?? null,
      opts.status ?? 'pending',
    ) as { id: string }).id;
}

/** Attach a suggested tag to a possible task (creating the tag with a given kind). */
function tagPossible(possibleId: string, tagName: string, kind: string, owner = OWNER): string {
  const tagId = (sqlite
    .prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(tagName, kind, owner) as { id: string }).id;
  sqlite.prepare(`INSERT INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)`).run(possibleId, tagId);
  return tagId;
}

function syncEventCount(owner: string, event: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_events WHERE owner_id = ? AND event = ?`).get(owner, event) as { n: number }).n;
}
function possibleStatus(id: string): string | undefined {
  return (sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(id) as { status: string } | undefined)?.status;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('PossibleTaskType — queries', () => {
  it('lists the owner\'s pending possibles with fields mapped', async () => {
    insertPossible('Call dentist', OWNER, { rawSummary: 'from email', proposedPriority: 2, sourceKind: 'gmail', confidence: 0.8 });
    insertPossible('Already handled', OWNER, { status: 'promoted' }); // not pending → excluded

    const r = await gql('{ possibleTasks { id rawTitle rawSummary status confidence proposedPriority sourceKind } }');
    expect(r.body.errors).toBeUndefined();
    const list = r.body.data.possibleTasks;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      rawTitle: 'Call dentist', rawSummary: 'from email', status: 'pending',
      confidence: 0.8, proposedPriority: 2, sourceKind: 'gmail',
    });
  });

  it('possibleTasks(status:) filters by status', async () => {
    insertPossible('Pending one', OWNER);
    insertPossible('Dismissed one', OWNER, { status: 'dismissed' });
    const r = await gql('{ possibleTasks(status: "dismissed") { rawTitle } }');
    expect(r.body.data.possibleTasks.map((p: any) => p.rawTitle)).toEqual(['Dismissed one']);
  });

  it('possibleTask(id) fetches one; unknown id is null', async () => {
    const id = insertPossible('Solo', OWNER);
    const r = await gql(`{ possibleTask(id: "${id}") { id rawTitle } }`);
    expect(r.body.data.possibleTask).toEqual({ id, rawTitle: 'Solo' });
    const miss = await gql('{ possibleTask(id: "nope") { id } }');
    expect(miss.body.data.possibleTask).toBeNull();
  });
});

describe('PossibleTaskType — mutations reuse the REST service', () => {
  it('promotePossibleTask creates a task, carries tags, flips status, fires SSE', async () => {
    const id = insertPossible('Draft proposal', OWNER, { rawSummary: 'sum', proposedPriority: 1 });
    tagPossible(id, 'work', 'direction'); // level 1 (placement-relevant)
    tagPossible(id, 'focus', 'intention'); // level 2 (secondary)
    const before = syncEventCount(OWNER, 'possible:promoted');

    const m = await gql(
      `mutation { promotePossibleTask(input: { id: "${id}" }) { success task { id title priority } possibleTask { status } } }`,
    );
    expect(m.body.errors).toBeUndefined();
    const p = m.body.data.promotePossibleTask;
    expect(p.success).toBe(true);
    expect(p.task).toMatchObject({ title: 'Draft proposal', priority: 1 });
    expect(p.possibleTask.status).toBe('promoted');

    // Tags carried onto the promoted task's entity_tags at the right levels.
    const levels = sqlite
      .prepare(`SELECT tg.name AS name, et.level AS level FROM entity_tags et JOIN tags tg ON tg.id = et.tag_id WHERE et.entity_kind = 'task' AND et.entity_id = ? ORDER BY tg.name`)
      .all(p.task.id) as { name: string; level: number }[];
    expect(levels).toEqual([
      { name: 'focus', level: 2 },
      { name: 'work', level: 1 },
    ]);

    // Status flipped in the store; promoted_task_id set.
    expect(possibleStatus(id)).toBe('promoted');
    const promotedTaskId = (sqlite.prepare(`SELECT promoted_task_id AS t FROM possible_tasks WHERE id = ?`).get(id) as { t: string }).t;
    expect(promotedTaskId).toBe(p.task.id);
    expect(syncEventCount(OWNER, 'possible:promoted')).toBe(before + 1);
  });

  it('promotePossibleTask honors title/dueAt/priority overrides', async () => {
    const id = insertPossible('Original', OWNER, { proposedPriority: 3 });
    const m = await gql(
      `mutation { promotePossibleTask(input: { id: "${id}", title: "Overridden", dueAt: "2026-08-01T10:00:00.000Z", priority: 5 }) { task { title priority dueAt } } }`,
    );
    expect(m.body.data.promotePossibleTask.task).toMatchObject({ title: 'Overridden', priority: 5, dueAt: '2026-08-01T10:00:00.000Z' });
  });

  it('promotedTask field resolves to the created task after promote', async () => {
    const id = insertPossible('Link me', OWNER);
    await gql(`mutation { promotePossibleTask(input: { id: "${id}" }) { task { id } } }`);
    const r = await gql(`{ possibleTask(id: "${id}") { status promotedTask { title } } }`);
    expect(r.body.data.possibleTask).toMatchObject({ status: 'promoted', promotedTask: { title: 'Link me' } });
  });

  it('promote matches the REST endpoint shape (shared service)', async () => {
    // REST promote of a separate possible yields 201 { task: {...} }.
    const restId = insertPossible('Via REST', OWNER);
    const rest = await api(srv.url, `/api/possible-tasks/${restId}/promote`, { method: 'POST', json: {} });
    expect(rest.status).toBe(201);
    expect(rest.body.task).toMatchObject({ title: 'Via REST', status: 'open' });
  });

  it('dismissPossibleTask flips status → dismissed + fires SSE', async () => {
    const id = insertPossible('Ignore me', OWNER);
    const before = syncEventCount(OWNER, 'possible:dismissed');
    const m = await gql(`mutation { dismissPossibleTask(input: { id: "${id}" }) { success possibleTask { status } } }`);
    expect(m.body.data.dismissPossibleTask).toEqual({ success: true, possibleTask: { status: 'dismissed' } });
    expect(possibleStatus(id)).toBe('dismissed');
    expect(syncEventCount(OWNER, 'possible:dismissed')).toBe(before + 1);
  });
});

describe('PossibleTaskType — owner scoping (reads + writes)', () => {
  it('another owner\'s possibles are invisible and don\'t bleed into the list', async () => {
    createOwner(OTHER);
    insertPossible('Mine', OWNER);
    insertPossible('Theirs-1', OTHER);
    insertPossible('Theirs-2', OTHER);

    expect((await gql('{ possibleTasks { rawTitle } }')).body.data.possibleTasks.map((p: any) => p.rawTitle)).toEqual(['Mine']);
    const b = await gql('{ possibleTasks { rawTitle } }', { 'x-test-owner': OTHER });
    expect(b.body.data.possibleTasks.map((p: any) => p.rawTitle).sort()).toEqual(['Theirs-1', 'Theirs-2']);
  });

  it('possibleTask(id) of another owner\'s item is null', async () => {
    createOwner(OTHER);
    const mine = insertPossible('Mine', OWNER);
    const r = await gql(`{ possibleTask(id: "${mine}") { id } }`, { 'x-test-owner': OTHER });
    expect(r.body.data.possibleTask).toBeNull();
  });

  it('cross-owner promote → NOT_FOUND and leaves the item untouched', async () => {
    createOwner(OTHER);
    const mine = insertPossible('Mine', OWNER);
    const m = await gql(`mutation { promotePossibleTask(input: { id: "${mine}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(m.body.errors?.[0]?.message).toMatch(/not found/i);
    expect(possibleStatus(mine)).toBe('pending'); // untouched
  });

  it('cross-owner dismiss → NOT_FOUND and leaves the item untouched', async () => {
    createOwner(OTHER);
    const mine = insertPossible('Mine', OWNER);
    const m = await gql(`mutation { dismissPossibleTask(input: { id: "${mine}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(m.body.errors?.[0]?.message).toMatch(/not found/i);
    expect(possibleStatus(mine)).toBe('pending'); // untouched
  });
});
