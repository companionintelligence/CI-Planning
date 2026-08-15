import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { logAssignment } from '../src/services/classification-learning.js';

/**
 * Phase 8 wiring — the two seams the learning loop actually hangs from.
 *
 * `classification-learning.test.ts` proves the rules; this proves they are CONNECTED:
 * the owner's edit of a machine-assigned field becomes evidence, and a field the
 * machine never touched stays out of the log. Both go through the REST surface, so
 * the assertion covers the route → service path a real edit takes rather than a
 * function called in isolation.
 */

const OWNER = SYSTEM_OWNER;

function insertTask(title: string): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES (uuid7(), ?, ?, 'open', 3) RETURNING id`)
    .get(title, OWNER) as { id: string }).id;
}

/** Category tags are stored under `normalizeTagName` (lower-kebab), and
 *  `categoryIdsForOwner` looks them up that way — a Capitalised fixture name resolves
 *  to nothing and silently writes no categories at all. */
function categoryTag(name: string): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`)
    .get(OWNER, name) as { id: string } | undefined;
  if (found) return found.id;
  return (sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`)
    .get(name, OWNER) as { id: string }).id;
}

const logFor = (taskId: string, field: string) =>
  sqlite.prepare(`SELECT * FROM classification_log WHERE task_id = ? AND field = ?`).get(taskId, field) as
    { llm_value: string; final_value: string | null; corrected_at: string | null } | undefined;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM classification_log; DELETE FROM classification_exemplars;');
});

describe('the owner’s edit becomes evidence', () => {
  it('records a category correction made through the API', async () => {
    const id = insertTask('Gym session before work');
    categoryTag('health');
    categoryTag('leisure');
    // The machine made a claim about this task.
    await logAssignment(OWNER, { taskId: id, field: 'category', inputText: 'Gym session before work', llmValue: ['leisure'] });

    const res = await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { categories: ['health'] } });
    expect(res.status).toBe(200);

    const row = logFor(id, 'category')!;
    expect(row.llm_value).toBe('leisure');
    expect(row.final_value).toBe('health');
    expect(row.corrected_at).not.toBeNull();
  });

  it('records a motivation correction made through the API', async () => {
    const id = insertTask('Help mum with her taxes');
    await logAssignment(OWNER, { taskId: id, field: 'motivation', inputText: 'Help mum with her taxes', llmValue: 'me' });

    const res = await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { motivation: 'them' } });
    expect(res.status).toBe(200);

    const row = logFor(id, 'motivation')!;
    expect(row.final_value).toBe('them');
  });

  it('logs nothing for a field the machine never claimed', async () => {
    // The owner categorising a task the model never touched teaches nothing — there
    // was no claim to correct, and a row here would poison the index with "you said
    // (nothing)" examples.
    const id = insertTask('Gym session before work');
    categoryTag('health');
    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { categories: ['health'] } });
    expect(logFor(id, 'category')).toBeUndefined();
  });

  it('leaves the log alone when the PATCH does not touch the field', async () => {
    const id = insertTask('Gym session before work');
    await logAssignment(OWNER, { taskId: id, field: 'category', inputText: 'Gym session before work', llmValue: ['leisure'] });

    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { title: 'Gym session' } });
    expect(logFor(id, 'category')!.corrected_at).toBeNull(); // still open, still pending
  });

  it('does not fail the task update when the learning log is broken', async () => {
    // The user's edit is the point; the log is bookkeeping. Losing one example is
    // acceptable, losing the user's edit is not.
    const id = insertTask('Gym session before work');
    categoryTag('health');
    sqlite.exec(`ALTER TABLE classification_log RENAME TO classification_log_hidden`);
    try {
      const res = await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { categories: ['health'] } });
      expect(res.status).toBe(200);
      const cats = sqlite.prepare(
        `SELECT COUNT(*) n FROM entity_categories WHERE entity_kind = 'task' AND entity_id = ?`,
      ).get(id) as { n: number };
      expect(cats.n).toBe(1); // the edit landed
    } finally {
      sqlite.exec(`ALTER TABLE classification_log_hidden RENAME TO classification_log`);
    }
  });
});

describe('the classifier reads the index', () => {
  it('leaves the enrichment prompt byte-identical for an owner with no corrections', async () => {
    // The degrade contract in one assertion: this feature adds NOTHING to the prompt
    // until the owner has actually taught it something.
    const { classificationHint } = await import('../src/services/classification-learning.js');
    expect(await classificationHint(OWNER, 'category', 'anything at all', { embedFn: null })).toBe('');
    expect(await classificationHint(OWNER, 'motivation', 'anything at all', { embedFn: null })).toBe('');
  });
});

describe('the trend and the reset', () => {
  it('reports each run’s measured accuracy, and a gap where nothing was measured', async () => {
    sqlite.prepare(
      `INSERT INTO classification_accuracy (owner_id, field, computed_date, held_out, correct, accuracy)
       VALUES (?, 'category', '2026-08-10', 8, 6, 0.75), (?, 'category', '2026-08-03', 0, 0, NULL)`,
    ).run(OWNER, OWNER);

    const res = await api(srv.url, '/api/classification/accuracy');
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { computed_date: string }) => r.computed_date)).toEqual(['2026-08-10', '2026-08-03']);
    expect(res.body.runs[0].accuracy).toBe(0.75);
    // "Not measured" must stay null all the way to the client — a chart that reads it
    // as 0 would draw a crash the owner never had.
    expect(res.body.runs[1].accuracy).toBeNull();
    expect(res.body.fields).toEqual(['category', 'motivation']);
  });

  it('resets the learned index without destroying the evidence', async () => {
    const id = insertTask('Gym session before work');
    await logAssignment(OWNER, { taskId: id, field: 'category', inputText: 'Gym session', llmValue: ['leisure'] });
    sqlite.prepare(
      `INSERT INTO classification_exemplars (owner_id, field, log_id, input_text, llm_value, correct_value, embedding, computed_date)
       VALUES (?, 'category', 'l1', 'Gym session', 'leisure', 'health', NULL, '2026-08-10')`,
    ).run(OWNER);

    const res = await api(srv.url, '/api/classification/exemplars', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(1);

    const left = sqlite.prepare(`SELECT COUNT(*) n FROM classification_exemplars WHERE owner_id = ?`).get(OWNER) as { n: number };
    expect(left.n).toBe(0);
    // The correction history survives, so the next weekly pass re-earns the adaptation
    // rather than the owner losing it.
    const log = sqlite.prepare(`SELECT COUNT(*) n FROM classification_log WHERE owner_id = ?`).get(OWNER) as { n: number };
    expect(log.n).toBe(1);
  });
});
