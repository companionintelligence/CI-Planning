import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { calibrateClassification, exemplarPrompt } from '../src/services/classification-learning.js';
import { ollama } from '../src/mcp/ollama.js';

/**
 * Phase 8 capture on the QUICK-ADD path — the one the plan calls "input → task parse",
 * and the path most classifications actually come from.
 *
 * The seam is `enrichQuick`, stubbed here so the model's pick is a fact of the fixture.
 * Partial mock, not a wholesale replacement: the route imports other things from this
 * module, and only the model seam may be stubbed.
 */
const { overlay, calls, carried } = vi.hoisted(() => ({
  overlay: { value: null as Record<string, unknown> | null },
  // Every call the routes made to the model seam, so the HINTS they chose are a fact a
  // test can read rather than something inferred from a prompt.
  calls: [] as { text: string; parsed: Record<string, unknown>; vocab: { categories?: string[] }; hints: unknown }[],
  // Fields the deterministic PARSE carries, standing in for syntax `parseQuick` does not
  // have yet (see the NB below). null = the real parse, untouched.
  carried: { value: null as Record<string, unknown> | null },
}));

vi.mock('../src/agents/quickadd.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agents/quickadd.js')>()),
  enrichQuick: async (text: string, parsed: Record<string, unknown>, vocab: { categories?: string[] }, hints: unknown) => {
    calls.push({ text, parsed, vocab, hints });
    // null = the model was unavailable, which the route catches and treats as
    // "deterministic parse only" (llm: false).
    if (overlay.value === null) throw new Error('OllamaUnavailable');
    return { ...parsed, ...overlay.value };
  },
}));

// Same partial-mock rule for the parse: the real one, plus whatever `carried` says the
// entry's own syntax supplied.
vi.mock('../src/engine/quickadd.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine/quickadd.js')>();
  return { ...real, parseQuick: (text: string) => ({ ...real.parseQuick(text), ...(carried.value ?? {}) }) };
});

const OWNER = SYSTEM_OWNER;

function categoryTag(name: string): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`)
    .get(OWNER, name) as { id: string } | undefined;
  if (found) return found.id;
  return (sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`)
    .get(name, OWNER) as { id: string }).id;
}

const logRows = () =>
  sqlite.prepare(`SELECT field, input_text, llm_value, final_value FROM classification_log WHERE owner_id = ? ORDER BY field`)
    .all(OWNER) as { field: string; input_text: string; llm_value: string; final_value: string | null }[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM classification_log;');
  categoryTag('leisure');
  categoryTag('health');
  overlay.value = null;
  carried.value = null;
  calls.length = 0;
});

describe('quick-add records what the model claimed', () => {
  it('logs the model’s category and motivation picks', async () => {
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const res = await api(srv.url, '/api/tasks/quick', { method: 'POST', json: { text: 'gym session tomorrow' } });
    expect(res.status).toBe(201);
    expect(res.body.llm).toBe(true);

    const rows = logRows();
    expect(rows.map((r) => r.field)).toEqual(['category', 'motivation']);
    expect(rows[0].llm_value).toBe('leisure');
    expect(rows[1].llm_value).toBe('me');
    // Keyed on the TITLE, so the indexed text and a later classification's query text
    // live in the same space (the parse strips "tomorrow" into scheduled_for).
    expect(rows[0].input_text).not.toContain('tomorrow');
  });

  it('logs nothing when the model did not run', async () => {
    // The degrade contract: no Ollama ⇒ the deterministic parse only, and nothing to
    // learn from because nothing was claimed.
    overlay.value = null;
    const res = await api(srv.url, '/api/tasks/quick', { method: 'POST', json: { text: 'gym session tomorrow' } });
    expect(res.status).toBe(201);
    expect(res.body.llm).toBe(false);
    expect(logRows()).toHaveLength(0);
  });

  // NB there is no test that a PARSE-supplied category is withheld from the log. The
  // route guards for it (`!parsed.categories?.length`), but `parseQuick` has no category
  // or motivation syntax today — the guard is forward-looking, and a test for it could
  // not fail. Add one with the syntax.

  it('an edit right after quick-add becomes a correction', async () => {
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const created = await api(srv.url, '/api/tasks/quick', { method: 'POST', json: { text: 'gym session' } });
    const id = created.body.task.id;

    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { categories: ['health'], motivation: 'them' } });

    const rows = logRows();
    expect(rows.find((r) => r.field === 'category')!.final_value).toBe('health');
    expect(rows.find((r) => r.field === 'motivation')!.final_value).toBe('them');
  });
});

// ── What the routes hand the model, and what they offer the wizard ────────────

const ROUTES = [
  { name: 'POST /api/tasks/quick/parse', path: '/api/tasks/quick/parse', status: 200 },
  { name: 'POST /api/tasks/quick', path: '/api/tasks/quick', status: 201 },
] as const;

const count = (table: string) =>
  (sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

/** One index row written directly, embedding NULL: quick-add reads the frequency path. */
let rowSeq = 0;
function exemplar(o: { field?: 'category' | 'motivation'; text: string; llm: string; correct: string }): void {
  sqlite.prepare(
    `INSERT INTO classification_exemplars (owner_id, field, log_id, input_text, llm_value, correct_value, embedding, computed_date)
     VALUES (?, ?, ?, ?, ?, ?, NULL, '2026-11-02')`,
  ).run(OWNER, o.field ?? 'category', `qa-${String(rowSeq++).padStart(4, '0')}`, o.text, o.llm, o.correct);
}

/** Hit a route with the overlay saying leisure/me; resolves with the response and the hints it chose. */
async function hit(path: string, text = 'gym session before work') {
  overlay.value = { categories: ['leisure'], motivation: 'me' };
  calls.length = 0;
  const res = await api(srv.url, path, { method: 'POST', json: { text } });
  expect(calls).toHaveLength(1);
  return { res, hints: calls[0].hints as { category: string; motivation: string }, call: calls[0] };
}

describe('quick-add hands the model the owner’s own corrections', () => {
  beforeEach(() => { rowSeq = 0; });

  for (const route of ROUTES) {
    it(`passes empty hints to an owner with no corrections on ${route.name}`, async () => {
      const { res, hints, call } = await hit(route.path);
      expect(res.status).toBe(route.status);
      // '' and not undefined: a hint is always a string, so enrichQuick has one shape to read.
      expect(hints).toEqual({ category: '', motivation: '' });
      expect(call.vocab.categories).toEqual(['health', 'leisure']);
      expect(call.text).toBe('gym session before work');
    });

    it(`passes each field's lesson, rendered as a past correction, on ${route.name}`, async () => {
      exemplar({ text: 'gym session before work', llm: 'leisure', correct: 'health' });
      exemplar({ field: 'motivation', text: 'help mum with her taxes', llm: 'me', correct: 'them' });
      const { res, hints } = await hit(route.path);
      expect(res.status).toBe(route.status);
      expect(hints.category).toContain('you said leisure; the user chose health');
      expect(hints.motivation).toContain('you said me; the user chose them');
      // The very text exemplarPrompt renders: enrichQuick places it and does not re-render it.
      expect(hints.category).toBe(exemplarPrompt([
        { logId: 'x', inputText: 'gym session before work', llmValue: 'leisure', correctValue: 'health' },
      ]));
    });

    it(`asks for no category lesson when the owner has no categories, on ${route.name}`, async () => {
      sqlite.exec(`DELETE FROM tags WHERE kind = 'category'`);
      exemplar({ text: 'gym session before work', llm: 'leisure', correct: 'health' });
      exemplar({ field: 'motivation', text: 'help mum with her taxes', llm: 'me', correct: 'them' });
      const { hints } = await hit(route.path);
      expect(hints.category).toBe('');
      expect(hints.motivation).toContain('the user chose them'); // the other field is unaffected
    });

    it(`drops a lesson the model could not act on, before the cut, on ${route.name}`, async () => {
      // 'gardening' is not one of the owner's categories, an empty answer is not a category,
      // and a half-valid pick is not choosable. Each outranks the one valid lesson by
      // frequency, and three distinct values fill the top 3 (RETRIEVE_K), so the valid one
      // is the fourth and only shows if the list is applied BEFORE the cut. Motivation
      // needs the same shape: 'someone', '' and 'nobody' are three distinct values ahead of
      // 'them', so a filter that ran after the cut would leave nothing.
      for (const gone of ['gardening', 'gardening', 'gardening', '', '', 'health, gardening', 'health, gardening']) {
        exemplar({ text: `old lesson ${rowSeq}`, llm: 'leisure', correct: gone });
      }
      exemplar({ text: 'gym session before work', llm: 'leisure', correct: 'health' });
      for (const gone of ['someone', 'someone', 'someone', '', '', 'nobody', 'nobody']) {
        exemplar({ field: 'motivation', text: `old motive ${rowSeq}`, llm: 'me', correct: gone });
      }
      exemplar({ field: 'motivation', text: 'help mum with her taxes', llm: 'me', correct: 'them' });

      const { hints } = await hit(route.path);
      expect(hints.category).toContain('you said leisure; the user chose health.');
      expect(hints.category).not.toContain('gardening');
      expect(hints.category).not.toContain('(nothing)');
      expect(hints.motivation).toContain('you said me; the user chose them.');
      expect(hints.motivation).not.toContain('someone');
      expect(hints.motivation).not.toContain('nobody');
      expect(hints.motivation).not.toContain('(nothing)');
    });

    it(`keeps a multi-category lesson whose names are all on the list, case aside, on ${route.name}`, async () => {
      exemplar({ text: 'gym then a long walk', llm: 'leisure', correct: 'Health, Leisure' });
      const { hints } = await hit(route.path);
      expect(hints.category).toContain('the user chose Health, Leisure.');
    });

    it(`still answers when the exemplar table is broken, with no hint, on ${route.name}`, async () => {
      // The hint is a read of derived state. Losing it must cost the hint and nothing else.
      exemplar({ text: 'gym session before work', llm: 'leisure', correct: 'health' });
      sqlite.exec(`ALTER TABLE classification_exemplars RENAME TO classification_exemplars_hidden`);
      try {
        const { res, hints } = await hit(route.path);
        expect(res.status).toBe(route.status);
        expect(res.body.llm).toBe(true);
        expect(hints).toEqual({ category: '', motivation: '' });
      } finally {
        sqlite.exec(`ALTER TABLE classification_exemplars_hidden RENAME TO classification_exemplars`);
      }
    });

    it(`does not ask the embedder, on ${route.name}`, async () => {
      exemplar({ text: 'gym session before work', llm: 'leisure', correct: 'health' });
      const ready = vi.spyOn(ollama, 'embedReady').mockResolvedValue(true);
      const embed = vi.spyOn(ollama, 'embed').mockRejectedValue(new Error('should not be called'));
      try {
        const { hints } = await hit(route.path);
        expect(hints.category).toContain('the user chose health');
        expect(ready).not.toHaveBeenCalled();
        expect(embed).not.toHaveBeenCalled();
      } finally {
        ready.mockRestore();
        embed.mockRestore();
      }
    });
  }
});

describe('the parse route offers the wizard the model’s category pick', () => {
  const post = (text = 'gym session tomorrow') =>
    api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text } });

  it('carries a claim of the title and the categories the overlay chose', async () => {
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.llm).toBe(true);
    expect(res.body.classification_claim).toEqual({ text: res.body.parsed.title, categories: ['leisure'] });
    // The TITLE, not the raw entry: "tomorrow" went into scheduled_for.
    expect(res.body.classification_claim.text).not.toContain('tomorrow');
  });

  it('keeps the model’s order, and never puts motivation in the claim', async () => {
    overlay.value = { categories: ['leisure', 'health'], motivation: 'them' };
    const res = await post();
    expect(res.body.classification_claim.categories).toEqual(['leisure', 'health']);
    expect(Object.keys(res.body.classification_claim).sort()).toEqual(['categories', 'text']);
  });

  it('has no claim, and the same response as ever, when the model did not run', async () => {
    overlay.value = null;
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.llm).toBe(false);
    expect('classification_claim' in res.body).toBe(false);
    expect(Object.keys(res.body).sort()).toEqual(['llm', 'parsed']);
  });

  it('has no claim when the model chose no category', async () => {
    for (const none of [{ motivation: 'me' }, { categories: [], motivation: 'me' }, {}]) {
      overlay.value = none;
      const res = await post();
      expect(res.body.llm).toBe(true);
      expect('classification_claim' in res.body).toBe(false);
      expect(Object.keys(res.body).sort()).toEqual(['llm', 'parsed']);
    }
  });

  it('has no claim for a category the entry itself carried', async () => {
    // Simulates the syntax parseQuick does not have yet: a category the owner TYPED is not
    // the model's claim, and "correcting" your own words teaches nothing.
    carried.value = { categories: ['health'] };
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const res = await post();
    expect(res.body.llm).toBe(true);
    expect('classification_claim' in res.body).toBe(false);
  });

  it('still offers the category when only the MOTIVATION was carried by the entry', async () => {
    carried.value = { motivation: 'them' };
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const res = await post();
    expect(res.body.classification_claim.categories).toEqual(['leisure']);
  });

  it('writes nothing: no task, no audit row, no log row, no change to the index', async () => {
    exemplar({ text: 'gym session before work', llm: 'leisure', correct: 'health' });
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const res = await post();
    expect(res.body.classification_claim).toBeDefined();
    expect(count('tasks')).toBe(0);
    expect(count('audit_log')).toBe(0);
    expect(count('classification_log')).toBe(0);
    expect(count('classification_exemplars')).toBe(1);
  });
});

describe('quick-add still records what the model claimed', () => {
  const quick = (text: string) => api(srv.url, '/api/tasks/quick', { method: 'POST', json: { text } });
  const rows = () =>
    sqlite.prepare(`SELECT task_id, field, input_text, llm_value, final_value, corrected_at FROM classification_log WHERE owner_id = ? ORDER BY field`)
      .all(OWNER) as { task_id: string; field: string; input_text: string; llm_value: string; final_value: string | null; corrected_at: string | null }[];

  it('writes one OPEN row per chosen field, against the created task, keyed on its title', async () => {
    overlay.value = { categories: ['leisure', 'health'], motivation: 'them' };
    const res = await quick('help mum with the gym tomorrow');
    expect(res.status).toBe(201);
    const title = res.body.task.title;
    expect(title).not.toContain('tomorrow');
    expect(rows()).toEqual([
      { task_id: res.body.task.id, field: 'category', input_text: title, llm_value: 'leisure, health', final_value: null, corrected_at: null },
      { task_id: res.body.task.id, field: 'motivation', input_text: title, llm_value: 'them', final_value: null, corrected_at: null },
    ]);
  });

  it('logs only the field the model actually chose', async () => {
    overlay.value = { categories: ['leisure'] };
    await quick('gym session');
    expect(rows().map((r) => r.field)).toEqual(['category']);

    sqlite.exec('DELETE FROM classification_log');
    overlay.value = { motivation: 'us' };
    await quick('plan the holiday together');
    expect(rows().map((r) => r.field)).toEqual(['motivation']);

    sqlite.exec('DELETE FROM classification_log');
    overlay.value = {};
    await quick('gym session');
    expect(rows()).toHaveLength(0);
  });

  it('logs nothing for fields the entry itself carried', async () => {
    carried.value = { categories: ['health'], motivation: 'them' };
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const res = await quick('gym session');
    expect(res.body.llm).toBe(true);
    expect(rows()).toHaveLength(0);

    // …and only the carried one is withheld.
    carried.value = { categories: ['health'] };
    await quick('gym session');
    expect(rows().map((r) => r.field)).toEqual(['motivation']);
  });

  it('is unchanged by the hints it was given', async () => {
    exemplar({ text: 'gym session before work', llm: 'leisure', correct: 'health' });
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const res = await quick('gym session');
    expect(res.status).toBe(201);
    expect(rows().map((r) => [r.field, r.llm_value])).toEqual([['category', 'leisure'], ['motivation', 'me']]);
  });
});

describe('the owner’s acceptance test, through the real routes', () => {
  it('correcting a category twice in the wizard teaches the third parse, after the weekly run', async () => {
    overlay.value = { categories: ['leisure'], motivation: 'me' };
    const preview = (text: string) => api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text } });
    const hintsOfNextParse = async () => {
      calls.length = 0;
      await preview('go for a run');
      return calls[0].hints as { category: string; motivation: string };
    };

    // The wizard: preview the entry, take the model's pick, change it, Add. No model involved
    // beyond the stubbed overlay, and no direct write to the log.
    for (const text of ['gym session before work', 'gym workout with a trainer']) {
      const shown = await preview(text);
      expect(shown.body.classification_claim.categories).toEqual(['leisure']);
      const added = await api(srv.url, '/api/tasks', {
        method: 'POST',
        json: { title: shown.body.parsed.title, categories: ['health'], classification_claim: shown.body.classification_claim },
      });
      expect(added.status).toBe(201);
    }
    const evidence = sqlite.prepare(`SELECT llm_value, final_value, corrected_at FROM classification_log WHERE owner_id = ? AND field = 'category'`)
      .all(OWNER) as { llm_value: string; final_value: string | null; corrected_at: string | null }[];
    expect(evidence).toHaveLength(2);
    for (const r of evidence) {
      expect(r.llm_value).toBe('leisure');
      expect(r.final_value).toBe('health');
      expect(r.corrected_at).not.toBeNull();
    }

    // Learning is batch: the corrections are evidence now, and in no prompt yet.
    expect(await hintsOfNextParse()).toEqual({ category: '', motivation: '' });

    await calibrateClassification(OWNER, new Date(), { embedFn: null });
    const taught = await hintsOfNextParse();
    expect(taught.category).toContain('you said leisure; the user chose health');
    expect(taught.motivation).toBe(''); // nothing was ever corrected about who a task is for

    // The reset restores the stock prompt: the hint is a read of the index and nothing else.
    const reset = await api(srv.url, '/api/classification/exemplars', { method: 'DELETE' });
    expect(reset.status).toBe(200);
    expect(reset.body.cleared).toBe(2);
    expect(await hintsOfNextParse()).toEqual({ category: '', motivation: '' });
  });
});
