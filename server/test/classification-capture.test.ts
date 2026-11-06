import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { calibrateClassification, logAssignment, rowOutcome, CORRECTION_FLOOR, PENDING_MS } from '../src/services/classification-learning.js';

/**
 * Phase 8 wiring — the seams the learning loop actually hangs from: quick-add and the
 * memory fill-in log what the model claimed, updateTask records the owner's answer, and
 * the wizard's Add settles the echoed preview claim (from the claim cases below).
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
function categoryTag(name: string, owner: string = OWNER): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`)
    .get(owner, name) as { id: string } | undefined;
  if (found) return found.id;
  return (sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`)
    .get(name, owner) as { id: string }).id;
}

const logFor = (taskId: string, field: string) =>
  sqlite.prepare(`SELECT * FROM classification_log WHERE task_id = ? AND field = ?`).get(taskId, field) as
    { llm_value: string; final_value: string | null; corrected_at: string | null } | undefined;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM classification_log; DELETE FROM classification_exemplars; DELETE FROM classification_accuracy;');
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

  describe('a beneficiary set', () => {
    // The wizard sends `beneficiary_ids`; the server derives the motivation axis from it.
    const person = (name: string) =>
      (sqlite.prepare(`INSERT INTO people (id, owner_id, display_name) VALUES (uuid7(), ?, ?) RETURNING id`).get(OWNER, name) as { id: string }).id;
    const setBeneficiaries = (id: string, ids: string[]) =>
      api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { beneficiary_ids: ids } });

    it('closes an open motivation row when it changes the axis', async () => {
      const id = insertTask('Help mum with her taxes');
      await logAssignment(OWNER, { taskId: id, field: 'motivation', inputText: 'Help mum with her taxes', llmValue: 'me' });
      expect((await setBeneficiaries(id, [person('Mum')])).status).toBe(200);
      expect(logFor(id, 'motivation')).toMatchObject({ llm_value: 'me', final_value: 'them' });
    });

    it('leaves the row open when the set re-derives the axis the task already has', async () => {
      const id = insertTask('Help mum with her taxes');
      const mum = person('Mum');
      expect((await setBeneficiaries(id, [mum])).status).toBe(200); // axis is now 'them'
      await logAssignment(OWNER, { taskId: id, field: 'motivation', inputText: 'Help mum with her taxes', llmValue: 'them' });

      // The wizard's Edit re-sends the set it was seeded with: not an answer.
      expect((await setBeneficiaries(id, [mum])).status).toBe(200);
      expect(logFor(id, 'motivation')).toMatchObject({ final_value: null, corrected_at: null });

      // A second person that leaves the axis at 'them' is also not an answer.
      expect((await setBeneficiaries(id, [mum, person('Dad')])).status).toBe(200);
      expect(logFor(id, 'motivation')).toMatchObject({ final_value: null, corrected_at: null });

      // ...so a real correction can still follow, and clearing the set (axis back to null) is one.
      expect((await setBeneficiaries(id, [])).status).toBe(200);
      expect(logFor(id, 'motivation')).toMatchObject({ final_value: '' });
      expect(logFor(id, 'motivation')!.corrected_at).not.toBeNull();
    });
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

// ── The wizard's Add ──────────────────────────────────────────────────────────
//
// The Describe-it line previews the parse, the owner may change the category it chose,
// and Add creates the task through the ordinary POST /api/tasks. The preview route is
// zero-write, so what the model claimed has to ride the create as `classification_claim`
// and be settled once the task exists. The server decides everything that matters: the
// owner is the caller, the task and its title are the row just created, the names must be
// the caller's own, and the final value is read back from the database.

describe('the wizard’s Add records the preview’s category pick', () => {
  type Row = {
    id: string; owner_id: string; task_id: string | null; field: string; input_text: string;
    llm_value: string; final_value: string | null; assigned_at: string; corrected_at: string | null;
  };
  const TITLE = 'Gym session before work';
  const WEEK = 7 * 86_400_000;

  const rows = (owner = OWNER) =>
    sqlite.prepare(`SELECT * FROM classification_log WHERE owner_id = ? ORDER BY assigned_at, id`).all(owner) as Row[];
  const claim = (categories: unknown = ['leisure'], text: unknown = TITLE) => ({ text, categories });
  const create = (extra: Record<string, unknown>, headers?: Record<string, string>) =>
    api(srv.url, '/api/tasks', { method: 'POST', json: { title: TITLE, ...extra }, headers });
  const tagFor = (name: string, owner: string) =>
    sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`).get(owner, name) as { id: string } | undefined;

  beforeEach(() => {
    for (const name of ['health', 'leisure', 'career', 'growth']) categoryTag(name);
  });

  it('writes one OPEN row when the owner left the pick alone', async () => {
    const res = await create({ categories: ['leisure'], classification_claim: claim() });
    expect(res.status).toBe(201);
    expect(res.body.task.categories).toEqual(['leisure']);

    expect(rows()).toHaveLength(1);
    const [row] = rows();
    expect(row).toMatchObject({
      owner_id: OWNER, task_id: res.body.task.id, field: 'category',
      input_text: TITLE, llm_value: 'leisure', final_value: null, corrected_at: null,
    });
    // Pending for a day like every other assignment, and a weak accept only after it.
    expect(rowOutcome(row, new Date())).toBeNull();
    expect(rowOutcome(row, new Date(Date.now() + 2 * PENDING_MS))).toBe('accepted');
  });

  it('writes the row already CLOSED when the owner changed the pick', async () => {
    const res = await create({ categories: ['health'], classification_claim: claim() });
    expect(res.status).toBe(201);
    expect(rows()).toHaveLength(1);
    const [row] = rows();
    expect(row).toMatchObject({ task_id: res.body.task.id, llm_value: 'leisure', final_value: 'health' });
    expect(row.corrected_at).not.toBeNull();
    expect(row.corrected_at).toBe(row.assigned_at); // one instant: the owner answered as it was made
    // A correction now and a week on: it never ages into an accept of the MODEL's value.
    expect(rowOutcome(row, new Date())).toBe('corrected');
    expect(rowOutcome(row, new Date(Date.now() + WEEK))).toBe('corrected');
  });

  it('records an emptied picker as a correction to "", not an acceptance', async () => {
    const res = await create({ categories: [], classification_claim: claim() });
    expect(res.status).toBe(201);
    expect(res.body.task.categories).toEqual([]);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row.final_value).toBe('');           // the empty string, not NULL
    expect(row.corrected_at).not.toBeNull();
    expect(rowOutcome(row, new Date(Date.now() + WEEK))).toBe('corrected');
  });

  it('treats the same names in a different order as a correction', async () => {
    const res = await create({ categories: ['health', 'leisure'], classification_claim: claim(['leisure', 'health']) });
    expect(res.status).toBe(201);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row.llm_value).toBe('leisure, health');
    expect(row.final_value).toBe('health, leisure');
    expect(rowOutcome(row, new Date())).toBe('corrected');
  });

  it('reads the final value back from the database, never from the request', async () => {
    // "nonexistent" never lands; "health" is sent twice and stored once. What the owner
    // ended up with is what is recorded, whatever the body said.
    const res = await create({ categories: ['health', 'nonexistent', 'health'], classification_claim: claim() });
    expect(res.status).toBe(201);
    expect(res.body.task.categories).toEqual(['health']);
    expect(rows().map((r) => [r.llm_value, r.final_value])).toEqual([['leisure', 'health']]);
  });

  it('stores the claim in the vocabulary’s own casing, and takes up to three names', async () => {
    const res = await create({ categories: ['leisure', 'health', 'career'], classification_claim: claim(['LEISURE', 'Health', 'career']) });
    expect(res.status).toBe(201);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row.llm_value).toBe('leisure, health, career'); // not the client's spelling
    expect(row.final_value).toBeNull();                    // and equal to what was saved
  });

  it('records a claim about a repeating task or a habit against the TEMPLATE', async () => {
    const habit = await create({ recurrence_rule: 'FREQ=DAILY', is_habit: true, categories: ['leisure'], classification_claim: claim() });
    expect(habit.status).toBe(201);
    const repeating = await create({ recurrence_rule: 'FREQ=WEEKLY', categories: ['health'], classification_claim: claim() });
    expect(repeating.status).toBe(201);

    const got = rows();
    expect(got.map((r) => r.task_id).sort()).toEqual([habit.body.task.id, repeating.body.task.id].sort());
    for (const id of [habit.body.task.id, repeating.body.task.id]) {
      const t = sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as { status: string };
      expect(t.status).toBe('recurring');
    }
    const byTask = (id: string) => got.find((r) => r.task_id === id)!;
    expect(byTask(habit.body.task.id)).toMatchObject({ llm_value: 'leisure', final_value: null, corrected_at: null });
    expect(byTask(repeating.body.task.id)).toMatchObject({ llm_value: 'leisure', final_value: 'health' });
    // One row per create, not one per generated instance.
    expect(got).toHaveLength(2);
  });

  it('writes nothing for a create the route refuses before any task exists', async () => {
    // All three return before a row is written, so this pins only that a refused create
    // records nothing. That the settle waits for a SUCCESSFUL create is the dependency
    // cycle test below, where the task row exists and the create still fails.
    const withClaim = { categories: ['health'], classification_claim: claim() };
    expect((await create({ ...withClaim, title: '' })).status).toBe(400);
    expect((await create({ ...withClaim, motivation: 'everyone' })).status).toBe(422);
    expect((await create({ ...withClaim, recurrence_rule: 'NOT A RULE' })).status).toBe(422);
    expect(rows()).toHaveLength(0);
  });

  it('writes nothing for a create that fails on a dependency cycle', async () => {
    // A brand-new task cannot normally close a loop, so make it: the moment the row is
    // inserted, its blocker is made to depend on it. The 409 comes AFTER the row was
    // written, which is exactly when a careless settle would record it.
    const blocker = insertTask('Blocker');
    sqlite.exec(
      `CREATE TRIGGER zz_capture_cycle AFTER INSERT ON tasks WHEN NEW.title = 'Cycle me'
       BEGIN INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('${blocker}', NEW.id); END`,
    );
    try {
      const res = await create({ title: 'Cycle me', depends_on: [blocker], categories: ['health'], classification_claim: claim(['leisure'], 'Cycle me') });
      expect(res.status).toBe(409);
      expect(rows()).toHaveLength(0);
    } finally {
      sqlite.exec(`DROP TRIGGER IF EXISTS zz_capture_cycle`);
    }
  });

  describe('is silently dropped, and the task still created, when', () => {
    /** The create succeeded exactly as it would have without the claim, and nothing was recorded. */
    async function dropped(extra: Record<string, unknown>, title = TITLE) {
      const res = await create({ title, ...extra });
      expect(res.status).toBe(201);
      expect(rows()).toHaveLength(0);
      return res;
    }

    it('the claim is about other text than the task’s title', async () => {
      for (const text of ['gym session before work', 'Gym  session before work', 'Gym session', `${TITLE}.`, 'Water the plants']) {
        const res = await dropped({ categories: ['health'], classification_claim: claim(['leisure'], text) });
        expect(res.body.task.categories).toEqual(['health']); // the owner's Add itself is untouched
      }
    });

    it('a name is not in the owner’s vocabulary, in any of its forms', async () => {
      // This pins that each form is dropped, not which guard drops it (the debug reason
      // is not read here). In particular the four-name case does not isolate the shape
      // cap: 'growth' is muted below and the vocabulary cap is three too, so the
      // vocabulary count would refuse it even without the shape check.
      sqlite.prepare(`UPDATE tags SET muted = 1 WHERE owner_id = ? AND name = 'growth'`).run(OWNER);
      createOwner(SECOND_OWNER_ID);
      categoryTag('secret', SECOND_OWNER_ID);
      const bad: unknown[] = [
        ['leisure', 'nonexistent'],        // unknown: the WHOLE claim goes, not just the name
        ['nonexistent'],
        ['growth'],                        // muted
        ['secret'],                        // another owner's
        ['leisure', 'leisure'],            // a duplicate
        ['leisure', 'health', 'career', 'growth'], // four names, one of them muted
      ];
      for (const categories of bad) {
        await dropped({ categories: ['health'], classification_claim: claim(categories) });
      }
    });

    it('a name is not a string', async () => {
      for (const categories of [['leisure', 5], [null], [{ name: 'leisure' }], [['leisure']]]) {
        await dropped({ categories: ['health'], classification_claim: claim(categories) });
      }
    });

    it('the claim is malformed', async () => {
      const bad: unknown[] = [
        'leisure', ['leisure'], null, 42, true,
        { categories: ['leisure'] },
        { text: TITLE },
        { text: TITLE, categories: 'leisure' },
        { text: TITLE, categories: {} },
        { text: TITLE, categories: [] },
        { text: '', categories: ['leisure'] },
        { text: 5, categories: ['leisure'] },
        { text: [TITLE], categories: ['leisure'] },
      ];
      for (const c of bad) await dropped({ categories: ['health'], classification_claim: c });
    });

    it('the claim is hostile in size', async () => {
      // Dropped. Which guard refuses it is not observable here: the shape check does on its
      // length before anything iterates it, but the vocabulary count (10,000 copies dedupe
      // to one name) would refuse it as well.
      await dropped({ categories: ['health'], classification_claim: claim(new Array(10_000).fill('leisure')) });
      // 501 characters is over the line even when the title IS that long: classificationInput
      // would slice both to 500 and call them equal, so only the raw length can refuse it.
      const long = 'a'.repeat(501);
      await dropped({ categories: ['health'], classification_claim: claim(['leisure'], long) }, long);
    });

    it('no categories were sent at all', async () => {
      // `undefined` means "leave them alone", which is not an answer. Only a list, even an
      // empty one, is the owner's.
      const res = await dropped({ classification_claim: claim() });
      expect(res.body.task.categories).toEqual([]);
    });

    it('categories were sent but none of them landed', async () => {
      const res = await dropped({ categories: ['nonexistent'], classification_claim: claim() });
      expect(res.body.task.categories).toEqual([]);
    });
  });

  it('still records a claim at the longest text that is allowed', async () => {
    const edge = 'a'.repeat(500);
    const res = await create({ title: edge, categories: ['health'], classification_claim: claim(['leisure'], edge) });
    expect(res.status).toBe(201);
    expect(rows().map((r) => [r.input_text, r.final_value])).toEqual([[edge, 'health']]);
  });

  it('changes nothing about the create: same response, nothing stored, nothing echoed', async () => {
    const plain = await create({ categories: ['health'] });
    expect(rows()).toHaveLength(0);
    const withClaim = await create({ categories: ['health'], classification_claim: claim() });

    expect(withClaim.status).toBe(plain.status);
    expect(Object.keys(withClaim.body).sort()).toEqual(Object.keys(plain.body).sort());
    expect(Object.keys(withClaim.body.task).sort()).toEqual(Object.keys(plain.body.task).sort());
    expect(withClaim.body.task.categories).toEqual(plain.body.task.categories);

    // Never returned, never stored, never audited.
    expect(JSON.stringify(withClaim.body)).not.toContain('classification_claim');
    for (const table of ['tasks', 'audit_log', 'sync_events']) {
      const all = sqlite.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(all), table).not.toContain('classification_claim');
    }
    expect(rows()).toHaveLength(1); // the one claim, and only it
  });

  it('writes no row when there is no claim', async () => {
    const res = await create({ categories: ['health'] });
    expect(res.status).toBe(201);
    expect(rows()).toHaveLength(0);
  });

  it('still creates the task when the learning log is broken', async () => {
    sqlite.exec(`ALTER TABLE classification_log RENAME TO classification_log_hidden`);
    try {
      const res = await create({ categories: ['health'], classification_claim: claim() });
      expect(res.status).toBe(201);
      expect(res.body.task.categories).toEqual(['health']);
      const cats = sqlite.prepare(
        `SELECT COUNT(*) n FROM entity_categories WHERE entity_kind = 'task' AND entity_id = ?`,
      ).get(res.body.task.id) as { n: number };
      expect(cats.n).toBe(1);
    } finally {
      sqlite.exec(`ALTER TABLE classification_log_hidden RENAME TO classification_log`);
    }
  });

  it('still creates the task when the vocabulary cannot be read', async () => {
    // The settle reads the owner's suggestible vocabulary AFTER the create, so a failure
    // there must cost the evidence and nothing else. `muted` is only read by that query,
    // so hiding the column breaks it without breaking the create that already happened.
    sqlite.exec(`ALTER TABLE tags RENAME COLUMN muted TO muted_hidden`);
    try {
      const res = await create({ categories: ['health'], classification_claim: claim() });
      expect(res.status).toBe(201);
      expect(res.body.task.categories).toEqual(['health']);
      expect(rows()).toHaveLength(0);
    } finally {
      sqlite.exec(`ALTER TABLE tags RENAME COLUMN muted_hidden TO muted`);
    }
  });

  it('only ever writes to the caller’s own log', async () => {
    createOwner(SECOND_OWNER_ID);
    categoryTag('health', SECOND_OWNER_ID);
    // A category only this owner has: the claim is checked against THEIR vocabulary.
    categoryTag('wellbeing', SECOND_OWNER_ID);
    // Keys inside the claim are never read: not the owner, not the task, not a motivation.
    const forged = { ...claim(['wellbeing']), owner_id: OWNER, task_id: 'somebody-elses-task', motivation: 'them', field: 'motivation' };
    const res = await create({ categories: ['health'], classification_claim: forged }, { 'x-test-owner': SECOND_OWNER_ID });
    expect(res.status).toBe(201);

    expect(rows(OWNER)).toHaveLength(0);
    expect(rows(SECOND_OWNER_ID).map((r) => [r.owner_id, r.task_id, r.field, r.llm_value, r.final_value]))
      .toEqual([[SECOND_OWNER_ID, res.body.task.id, 'category', 'wellbeing', 'health']]);
    // …and the same names mean the caller's own tags: each owner resolves their own 'health'.
    expect(tagFor('health', SECOND_OWNER_ID)!.id).not.toBe(tagFor('health', OWNER)!.id);
    const saved = sqlite.prepare(`SELECT category_tag_id FROM entity_categories WHERE entity_id = ?`).get(res.body.task.id) as { category_tag_id: string };
    expect(saved.category_tag_id).toBe(tagFor('health', SECOND_OWNER_ID)!.id);
  });

  it('is not something a later edit can add to a task, only to settle', async () => {
    // The claim belongs to the create. The same key on a PATCH is just an unknown key.
    const id = insertTask(TITLE);
    const res = await api(srv.url, `/api/tasks/${id}`, {
      method: 'PATCH', json: { categories: ['health'], classification_claim: claim() },
    });
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  describe('a later edit of the categories', () => {
    const patch = (id: string, json: Record<string, unknown>, query = '') =>
      api(srv.url, `/api/tasks/${id}${query}`, { method: 'PATCH', json });
    /** A wizard Add that left the model's pick alone: an OPEN row on a task saved with it. */
    async function born(title: string, categories: string[] = ['leisure']): Promise<string> {
      const res = await create({ title, categories, classification_claim: claim(categories, title) });
      expect(res.status).toBe(201);
      return res.body.task.id;
    }
    const rowOf = (taskId: string) => rows().find((r) => r.task_id === taskId)!;

    it('closes an equal (open) row as the owner’s answer', async () => {
      const created = await create({ categories: ['leisure'], classification_claim: claim() });
      const id = created.body.task.id;
      const res = await patch(id, { categories: ['health'] });
      expect(res.status).toBe(200);
      const [row] = rows();
      expect(rows()).toHaveLength(1);
      expect(row.final_value).toBe('health');
      expect(row.corrected_at).not.toBeNull();
      expect(rowOutcome(row, new Date())).toBe('corrected');
    });

    it('leaves an open row open when the same pick is sent again, so a real correction can still follow', async () => {
      // Re-sending the same set (the wizard used to do it on every Edit, and REST, GraphQL
      // and agent callers still can) is no answer: counting it would freeze the row as
      // 'accepted' ahead of its 24h window and the correction made an hour later would be
      // the second answer, and lost.
      const id = await born(TITLE);
      const resend = await patch(id, { categories: ['leisure'], priority: 2 });
      expect(resend.status).toBe(200);
      const [open] = rows();
      expect(open).toMatchObject({ final_value: null, corrected_at: null });
      expect(rowOutcome(open, new Date())).toBeNull();                              // still pending
      expect(rowOutcome(open, new Date(Date.now() + 2 * PENDING_MS))).toBe('accepted'); // the weak accept, after a day

      await patch(id, { categories: ['health'] });
      const [closed] = rows();
      expect(rows()).toHaveLength(1);
      expect(closed.final_value).toBe('health');
      expect(rowOutcome(closed, new Date())).toBe('corrected');
    });

    it('closes an open row with the SAVED set, never the request', async () => {
      // The request says one thing and the database ends up holding another; the row
      // records the database. Each case has its own task, because the first answer wins.
      const cases: [string, string[], string][] = [
        ['Cased', ['Health', 'health'], 'health'],                                   // case and a duplicate
        ['Unknown', ['health', 'nonexistent'], 'health'],                            // a name that never lands
        ['Capped', ['career', 'health', 'leisure', 'growth'], 'career, health, leisure'], // the cap of three
      ];
      for (const [title, sent, saved] of cases) {
        const id = await born(title);
        const res = await patch(id, { categories: sent });
        expect(res.body.task.categories.join(', '), title).toBe(saved);
        expect(rowOf(id), title).toMatchObject({ llm_value: 'leisure', final_value: saved });
        expect(rowOutcome(rowOf(id), new Date()), title).toBe('corrected');
      }
    });

    it('treats a respelling of the saved set as no answer', async () => {
      // None of these changes what is saved, so none of them is the owner saying anything.
      // Recording the request would have called each a correction ('Leisure' != 'leisure').
      const sends: string[][] = [['Leisure'], ['leisure', 'nonexistent'], ['leisure', 'leisure']];
      for (const [i, sent] of sends.entries()) {
        const id = await born(`Respelled ${i}`);
        const res = await patch(id, { categories: sent });
        expect(res.body.task.categories).toEqual(['leisure']);
        expect(rowOf(id), JSON.stringify(sent)).toMatchObject({ final_value: null, corrected_at: null });
      }
    });

    it('counts a reorder as an answer, because the order is the stripe order', async () => {
      const id = await born(TITLE, ['leisure', 'health']);
      await patch(id, { categories: ['health', 'leisure'] });
      expect(rowOf(id)).toMatchObject({ llm_value: 'leisure, health', final_value: 'health, leisure' });
      expect(rowOutcome(rowOf(id), new Date())).toBe('corrected');
    });

    it('closes an open row with "" when the picker is emptied', async () => {
      const id = await born(TITLE);
      await patch(id, { categories: [] });
      expect(rowOf(id).final_value).toBe('');
      expect(rowOutcome(rowOf(id), new Date())).toBe('corrected');
    });

    it('takes an empty set sent to a task that already has none as no answer', async () => {
      const id = insertTask(TITLE);
      await logAssignment(OWNER, { taskId: id, field: 'category', inputText: TITLE, llmValue: ['leisure'] });
      const res = await patch(id, { categories: [] });
      expect(res.status).toBe(200);
      expect(rowOf(id)).toMatchObject({ final_value: null, corrected_at: null });
    });

    it('changes nothing on a row the Add already closed: the first answer wins', async () => {
      const created = await create({ categories: ['health'], classification_claim: claim() });
      const before = rows();
      const res = await patch(created.body.task.id, { categories: ['leisure'] });
      expect(res.status).toBe(200);
      expect(rows()).toEqual(before);
      expect(before[0].final_value).toBe('health');
    });

    describe('a series save from a generated instance', () => {
      // Instances carry no category rows, so the wizard's Edit of one opens with an empty
      // picker and a "this and future" save sends that picker to the TEMPLATE, where the
      // habit's open row lives.
      const habit = async (title: string) => {
        const res = await create({
          title, recurrence_rule: 'FREQ=DAILY', is_habit: true, categories: ['leisure'], classification_claim: claim(['leisure'], title),
        });
        expect(res.status).toBe(201);
        const template = res.body.task.id as string;
        const instance = sqlite.prepare(`SELECT id FROM tasks WHERE recurrence_parent_id = ? LIMIT 1`).get(template) as { id: string } | undefined;
        expect(instance, 'the create generates instances').toBeDefined();
        return { template, instance: instance!.id };
      };
      const series = (id: string, json: Record<string, unknown>) => patch(id, json, '?scope=series');

      it('leaves the template’s row open when it sends no categories, or the template’s own set', async () => {
        const a = await habit('Habit A');
        const b = await habit('Habit B');
        expect((await series(a.instance, { priority: 2 })).status).toBe(200);
        const res = await series(b.instance, { categories: ['leisure'] });
        expect(res.status).toBe(200);
        expect(res.body.task.categories).toEqual(['leisure']);
        for (const { template } of [a, b]) {
          expect(rowOf(template)).toMatchObject({ final_value: null, corrected_at: null });
        }
      });

      const listed = async (id: string) =>
        ((await api(srv.url, '/api/tasks')).body.tasks as { id: string; tags: string[]; secondary_tags: string[]; categories: string[] }[])
          .find((t) => t.id === id)!;

      it('does not apply the instance’s empty picker: the template keeps its categories and its open row', async () => {
        // Instances carry no tag or category rows, so the picker of one is always empty. A
        // series save through it used to clear the template's set and close its row as a
        // correction to '' that nobody made. The empty sets are now not applied at all.
        const habits = [await habit('Habit C'), await habit('Habit D')];
        for (const { template, instance } of habits) {
          const res = await series(instance, { categories: [] });
          expect(res.status).toBe(200);
          expect(res.body.task.categories).toEqual(['leisure']);
          expect(rowOf(template)).toMatchObject({ final_value: null, corrected_at: null });
        }
      });

      it('keeps the template’s tags when the instance sends empty ones, and applies non-empty ones', async () => {
        const res = await create({ title: 'Habit T', recurrence_rule: 'FREQ=DAILY', is_habit: true, tags: ['deep'], secondary_tags: ['focus'] });
        expect(res.status).toBe(201);
        const template = res.body.task.id as string;
        const instance = (sqlite.prepare(`SELECT id FROM tasks WHERE recurrence_parent_id = ? LIMIT 1`).get(template) as { id: string }).id;

        expect((await series(instance, { tags: [], secondary_tags: [], categories: [] })).status).toBe(200);
        expect(await listed(template)).toMatchObject({ tags: ['deep'], secondary_tags: ['focus'] });

        // one level empty, the other real: only the real one is written
        expect((await series(instance, { tags: [], secondary_tags: ['calm'] })).status).toBe(200);
        expect(await listed(template)).toMatchObject({ tags: ['deep'], secondary_tags: ['calm'] });
      });

      it('still clears when the series is addressed through the template, and for an instance-scope edit', async () => {
        const res = await create({ title: 'Habit U', recurrence_rule: 'FREQ=DAILY', is_habit: true, categories: ['leisure'], tags: ['deep'], secondary_tags: ['focus'] });
        const template = res.body.task.id as string;
        const instance = (sqlite.prepare(`SELECT id FROM tasks WHERE recurrence_parent_id = ? LIMIT 1`).get(template) as { id: string }).id;

        // an instance-scope edit writes that instance and never reaches the template
        expect((await patch(instance, { tags: [], categories: [] })).status).toBe(200);
        expect(await listed(template)).toMatchObject({ tags: ['deep'], categories: ['leisure'] });

        // the template's own id is how a series save says "clear them"
        expect((await series(template, { tags: [], secondary_tags: [], categories: [] })).status).toBe(200);
        expect(await listed(template)).toMatchObject({ tags: [], secondary_tags: [], categories: [] });
      });
    });
  });
});
