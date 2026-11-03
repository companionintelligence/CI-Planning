import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import {
  logAssignment, recordCorrection, logAnsweredAssignment, evidenceByKind, calibrateClassification,
  ENTITY_KINDS, LEARNING_WINDOW_DAYS, PENDING_MS,
} from '../src/services/classification-learning.js';

/**
 * Migration 0173: `classification_log` rows say what their id refers to, a task or a Time Block.
 *
 * What is pinned here: a row defaults to 'task'; a correction only settles a row of its own
 * kind; a Time Block born from a Describe-it claim logs under 'time_block' and an edit of its
 * categories settles that row; and the Learning card's counts split the same window the learner
 * reads by kind. The learner itself does not split the evidence (one vocabulary, one index).
 */

const OWNER = SYSTEM_OWNER;
const DAY = 86_400_000;
const TITLE = 'Deep work on the budget';

function categoryTag(name: string, owner: string = OWNER): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`)
    .get(owner, name) as { id: string } | undefined;
  if (found) return found.id;
  return (sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`)
    .get(name, owner) as { id: string }).id;
}

type Row = { id: string; task_id: string; entity_kind: string; field: string; llm_value: string; final_value: string | null; corrected_at: string | null };
const rows = (owner: string = OWNER) =>
  sqlite.prepare(`SELECT * FROM classification_log WHERE owner_id = ? ORDER BY rowid`).all(owner) as Row[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM classification_log; DELETE FROM classification_exemplars; DELETE FROM classification_accuracy;');
});

describe('the entity_kind column', () => {
  it('defaults to task for a row written without one, and is indexed with the id and field', () => {
    sqlite.prepare(
      `INSERT INTO classification_log (id, owner_id, task_id, field, input_text, llm_value, assigned_at, local_date)
       VALUES ('old-row', ?, 't1', 'category', 'x', '["a"]', '2026-01-01T00:00:00.000Z', '2026-01-01')`,
    ).run(OWNER);
    expect(rows()[0].entity_kind).toBe('task');
    const idx = sqlite.prepare(`PRAGMA index_info(ix_classification_log_entity)`).all() as { name: string }[];
    expect(idx.map((i) => i.name)).toEqual(['entity_kind', 'task_id', 'field']);
  });

  it('logAssignment and logAnsweredAssignment take a kind, and a task unless told otherwise', async () => {
    await logAssignment(OWNER, { taskId: 't1', field: 'category', inputText: 'a', llmValue: ['x'] });
    await logAssignment(OWNER, { taskId: 'b1', field: 'category', inputText: 'b', llmValue: ['x'], entityKind: 'time_block' });
    await logAnsweredAssignment(OWNER, { taskId: 'b2', field: 'category', inputText: 'c', llmValue: ['x'], finalValue: ['y'], entityKind: 'time_block' });
    await logAnsweredAssignment(OWNER, { taskId: 't2', field: 'category', inputText: 'd', llmValue: ['x'], finalValue: ['x'] });
    expect(rows().map((r) => [r.task_id, r.entity_kind])).toEqual([
      ['t1', 'task'], ['b1', 'time_block'], ['b2', 'time_block'], ['t2', 'task'],
    ]);
    expect(ENTITY_KINDS).toEqual(['task', 'time_block']);
  });

  it('a correction settles only a row of its own kind, even when the ids collide', async () => {
    await logAssignment(OWNER, { taskId: 'same-id', field: 'category', inputText: 'a', llmValue: ['x'] });
    await logAssignment(OWNER, { taskId: 'same-id', field: 'category', inputText: 'b', llmValue: ['x'], entityKind: 'time_block' });

    expect(await recordCorrection(OWNER, 'same-id', 'category', ['y'], undefined, 'time_block')).toBe(true);
    expect(rows().map((r) => [r.entity_kind, r.final_value])).toEqual([['task', null], ['time_block', 'y']]);

    expect(await recordCorrection(OWNER, 'same-id', 'category', ['z'])).toBe(true); // the default kind is task
    expect(rows().map((r) => [r.entity_kind, r.final_value])).toEqual([['task', 'z'], ['time_block', 'y']]);
  });
});

describe('a Time Block created from a Describe-it claim', () => {
  const start = '2026-11-10T09:00:00.000Z';
  const end = '2026-11-10T10:00:00.000Z';
  const claim = (categories: unknown = ['health'], text: unknown = TITLE) => ({ text, categories });
  const create = (extra: Record<string, unknown>) =>
    api<{ block: { id: string; title: string } }>(srv.url, '/api/blocks', {
      method: 'POST', json: { title: TITLE, start_at: start, end_at: end, block_kind: 'timeblock', ...extra },
    });

  beforeEach(() => { categoryTag('health'); categoryTag('leisure'); });

  it('writes one OPEN row under time_block when the owner left the pick alone', async () => {
    const res = await create({ categories: ['health'], classification_claim: claim() });
    expect(res.status).toBe(201);
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ task_id: res.body.block.id, entity_kind: 'time_block', field: 'category', llm_value: 'health', final_value: null, corrected_at: null });
  });

  it('writes the row already CLOSED when the owner changed the pick', async () => {
    const res = await create({ categories: ['leisure'], classification_claim: claim(['health']) });
    expect(res.status).toBe(201);
    expect(rows()[0]).toMatchObject({ entity_kind: 'time_block', llm_value: 'health', final_value: 'leisure' });
    expect(rows()[0].corrected_at).not.toBeNull();
  });

  it('never stores or returns the claim, and a block create without one logs nothing', async () => {
    const withClaim = await create({ categories: ['health'], classification_claim: claim() });
    expect(JSON.stringify(withClaim.body)).not.toContain('classification_claim');
    const stored = sqlite.prepare(`SELECT * FROM time_blocks WHERE id = ?`).get(withClaim.body.block.id) as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain('classification_claim');

    resetDb(); sqlite.exec('DELETE FROM classification_log');
    categoryTag('health');
    expect((await create({ categories: ['health'] })).status).toBe(201);
    expect(rows()).toEqual([]);
  });

  it.each([
    ['text of some other title', { classification_claim: claim(['health'], 'Something else'), categories: ['health'] }],
    ['a category outside the vocabulary', { classification_claim: claim(['finance']), categories: ['health'] }],
    ['a malformed claim', { classification_claim: { text: TITLE }, categories: ['health'] }],
    ['no categories sent with the create', { classification_claim: claim() }],
  ])('drops a claim with %s and still creates the block', async (_name, extra) => {
    const res = await create(extra);
    expect(res.status).toBe(201);
    expect(rows()).toEqual([]);
  });

  it('only ever writes to the caller’s own log', async () => {
    createOwner(SECOND_OWNER_ID);
    await create({ categories: ['health'], classification_claim: claim() });
    expect(rows(SECOND_OWNER_ID)).toEqual([]);
    expect(rows(OWNER)).toHaveLength(1);
  });

  describe('a later edit of its categories', () => {
    const patch = (id: string, json: Record<string, unknown>) => api(srv.url, `/api/blocks/${id}`, { method: 'PATCH', json });
    async function born(): Promise<string> {
      const res = await create({ categories: ['health'], classification_claim: claim() });
      expect(res.status).toBe(201);
      return res.body.block.id;
    }

    it('closes the open row with the SAVED set when the categories change', async () => {
      const id = await born();
      expect((await patch(id, { categories: ['leisure'] })).status).toBe(200);
      expect(rows()[0]).toMatchObject({ final_value: 'leisure', entity_kind: 'time_block' });
      expect(rows()[0].corrected_at).not.toBeNull();
    });

    it('leaves the row open when the same set is sent again, so a real correction can follow', async () => {
      const id = await born();
      expect((await patch(id, { categories: ['health'] })).status).toBe(200);
      expect(rows()[0]).toMatchObject({ final_value: null, corrected_at: null });
      expect((await patch(id, { categories: ['leisure'] })).status).toBe(200);
      expect(rows()[0].final_value).toBe('leisure');
    });

    it('records a cleared picker as an answer of "", and the first answer wins', async () => {
      const id = await born();
      expect((await patch(id, { categories: [] })).status).toBe(200);
      expect(rows()[0].final_value).toBe('');
      expect((await patch(id, { categories: ['leisure'] })).status).toBe(200);
      expect(rows()[0].final_value).toBe('');
    });

    it('leaves the log alone for a PATCH that does not touch categories, and for a block with no claim', async () => {
      const id = await born();
      expect((await patch(id, { title: 'Renamed' })).status).toBe(200);
      expect(rows()[0]).toMatchObject({ final_value: null, corrected_at: null });

      const plain = await create({ title: 'No claim here', categories: ['health'] });
      expect((await patch(plain.body.block.id, { categories: ['leisure'] })).status).toBe(200);
      expect(rows()).toHaveLength(1);
    });
  });
});

describe('evidenceByKind', () => {
  const NOW = new Date('2026-11-20T12:00:00.000Z');
  const insert = (o: { id: string; kind: 'task' | 'time_block'; field?: string; llm: string; final?: string | null; ageDays: number; correctedAgoDays?: number }) => {
    const assigned = new Date(NOW.getTime() - o.ageDays * DAY);
    const corrected = o.final != null ? new Date(NOW.getTime() - (o.correctedAgoDays ?? o.ageDays) * DAY) : null;
    sqlite.prepare(
      `INSERT INTO classification_log (id, owner_id, task_id, field, input_text, llm_value, final_value, assigned_at, corrected_at, local_date, entity_kind)
       VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?, ?, ?)`,
    ).run(o.id, OWNER, `e-${o.id}`, o.field ?? 'category', o.llm, o.final ?? null, assigned.toISOString(), corrected?.toISOString() ?? null, assigned.toISOString().slice(0, 10), o.kind);
  };

  it('splits decided rows and learnable corrections by field and kind, in a fixed order', async () => {
    insert({ id: 'a', kind: 'task', llm: 'x', final: 'y', ageDays: 10 });          // corrected
    insert({ id: 'b', kind: 'task', llm: 'x', final: 'x', ageDays: 10 });          // answered the same: accepted
    insert({ id: 'c', kind: 'task', llm: 'x', ageDays: 10 });                      // untouched for 10 days: accepted
    insert({ id: 'd', kind: 'time_block', llm: 'x', final: 'z', ageDays: 5 });      // corrected
    insert({ id: 'e', kind: 'time_block', llm: 'x', final: '', ageDays: 5 });       // cleared: decided, not learnable
    insert({ id: 'f', kind: 'time_block', field: 'motivation', llm: 'me', final: 'them', ageDays: 5 });
    expect(await evidenceByKind(OWNER, NOW)).toEqual([
      { field: 'category', entity_kind: 'task', decided: 3, corrections: 1 },
      { field: 'category', entity_kind: 'time_block', decided: 2, corrections: 1 },
      { field: 'motivation', entity_kind: 'time_block', decided: 1, corrections: 1 },
    ]);
  });

  it('leaves out a row still pending and a row whose GUESS is older than the window, even if corrected today', async () => {
    insert({ id: 'p', kind: 'task', llm: 'x', ageDays: 0 });                       // younger than 24h: pending
    insert({ id: 'old', kind: 'task', llm: 'x', final: 'y', ageDays: LEARNING_WINDOW_DAYS + 5, correctedAgoDays: 1 });
    insert({ id: 'edge', kind: 'time_block', llm: 'x', final: 'y', ageDays: LEARNING_WINDOW_DAYS - 1 });
    expect(PENDING_MS).toBe(DAY);
    expect(await evidenceByKind(OWNER, NOW)).toEqual([
      { field: 'category', entity_kind: 'time_block', decided: 1, corrections: 1 },
    ]);
  });

  it('counts only the caller’s own rows and is empty for an owner with none', async () => {
    createOwner(SECOND_OWNER_ID);
    insert({ id: 'mine', kind: 'task', llm: 'x', final: 'y', ageDays: 3 });
    expect(await evidenceByKind(SECOND_OWNER_ID, NOW)).toEqual([]);
    expect(await evidenceByKind(OWNER, NOW)).toHaveLength(1);
  });

  it('is served on the accuracy readout next to the runs', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 5 * DAY);
    sqlite.prepare(
      `INSERT INTO classification_log (id, owner_id, task_id, field, input_text, llm_value, final_value, assigned_at, corrected_at, local_date, entity_kind)
       VALUES ('r1', ?, 'b1', 'category', 't', 'x', 'y', ?, ?, ?, 'time_block')`,
    ).run(OWNER, old.toISOString(), old.toISOString(), old.toISOString().slice(0, 10));
    const res = await api<{ fields: string[]; runs: unknown[]; evidence: unknown[] }>(srv.url, '/api/classification/accuracy');
    expect(res.status).toBe(200);
    expect(res.body.evidence).toEqual([{ field: 'category', entity_kind: 'time_block', decided: 1, corrections: 1 }]);
    expect(res.body.runs).toEqual([]);
  });
});

describe('the learner reads both kinds as one body of evidence', () => {
  it('counts a Time Block correction toward the same floor as a task correction', async () => {
    const at = new Date(Date.now() - 3 * DAY);
    const put = (id: string, kind: string) => sqlite.prepare(
      `INSERT INTO classification_log (id, owner_id, task_id, field, input_text, llm_value, final_value, assigned_at, corrected_at, local_date, entity_kind)
       VALUES (?, ?, ?, 'category', ?, 'x', 'y', ?, ?, ?, ?)`,
    ).run(id, OWNER, `e-${id}`, `text ${id}`, at.toISOString(), at.toISOString(), at.toISOString().slice(0, 10), kind);
    put('t', 'task');
    put('b', 'time_block');
    const r = await calibrateClassification(OWNER, new Date(), { embedFn: null });
    expect(r.fields.find((f) => f.field === 'category')!.corrections).toBe(2);
  });
});
