import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { enrichQuick, mergeEnrichment } from '../src/agents/quickadd.js';
import { constrainToVocabulary } from '../src/agents/constrain.js';
import type { ParsedQuick } from '../src/engine/quickadd.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

/**
 * `categories` as a bare string (2 Nov 2026). The built-in fast model, qwen2.5:0.5b, answers
 * `"categories": "leisure"` where the prompt asks for a list, and gemma3:1b does on four calls in
 * five; quick-add used to keep lists only, so a default install never got a category pick, a preview
 * claim or anything to learn from. Quick-add's merge now reads a bare string as ONE whole name.
 * Evidence: docs/classification-shape-fix-2026-11.md.
 *
 * The seam is `generateJson`, stubbed so the model's answer is a fact of the fixture and the prompt
 * it was shown can be read back. Partial mock, not a wholesale replacement: only the model seam may
 * be stubbed, and the real enrichQuick, mergeEnrichment and routes run.
 */
const { prompts, reply } = vi.hoisted(() => ({
  prompts: [] as string[],
  // Includes a direction, so the second-chance direction call stays quiet.
  reply: { value: { direction: 'home', categories: 'leisure' } as Record<string, unknown> },
}));
vi.mock('../src/mcp/ollama.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mcp/ollama.js')>()),
  generateJson: async (prompt: string) => {
    prompts.push(prompt);
    return reply.value;
  },
}));

const DIRECTIONS = ['work', 'home', 'community'];
const VOCAB = { directions: DIRECTIONS, others: ['email'], categories: ['health', 'Career', 'leisure', 'Health, Fitness'] };
const base = (over: Partial<ParsedQuick> = {}): ParsedQuick => ({ title: 'gym session', tags: [], ...over });

describe('mergeEnrichment: a bare string for categories is one name', () => {
  it('takes it as one category, canonical casing, like a one-item list', () => {
    expect(mergeEnrichment(base(), { categories: 'leisure' }, VOCAB).categories).toEqual(['leisure']);
    expect(mergeEnrichment(base(), { categories: ' CAREER ' }, VOCAB).categories).toEqual(['Career']);
    expect(mergeEnrichment(base(), { categories: 'leisure' }, VOCAB).categories)
      .toEqual(mergeEnrichment(base(), { categories: ['leisure'] }, VOCAB).categories);
  });

  it('never invents: a string naming nothing, or a direction, is no pick', () => {
    // Measured answers of qwen2.5:0.5b that name no category: the prompt's own words, a direction, a made-up area.
    for (const raw of ['life areas', 'work', 'community', 'business', 'credit card', '']) {
      expect(mergeEnrichment(base(), { categories: raw }, VOCAB).categories, JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('does not split a string on commas: a list written as a string names nothing, a name with a comma still matches', () => {
    expect(mergeEnrichment(base(), { categories: 'health, leisure' }, VOCAB).categories).toBeUndefined();
    expect(mergeEnrichment(base(), { categories: 'Health, Fitness' }, VOCAB).categories).toEqual(['Health, Fitness']);
    expect(mergeEnrichment(base(), { categories: 'health, FITNESS' }, VOCAB).categories).toEqual(['Health, Fitness']); // case-insensitive, vocabulary casing
    expect(mergeEnrichment(base(), { categories: 'health,fitness' }, VOCAB).categories).toBeUndefined(); // not the name, and not split
  });

  it('leaves lists exactly as they were', () => {
    expect(mergeEnrichment(base(), { categories: ['Leisure', 'made-up', 'health', 'LEISURE', 'career', 'Health, Fitness'] }, VOCAB).categories)
      .toEqual(['leisure', 'health', 'Career']);
    expect(mergeEnrichment(base(), { categories: [] }, VOCAB).categories).toBeUndefined();
  });

  it('reads nothing else as a name', () => {
    for (const raw of [7, null, undefined, true, { a: 'leisure' }, [3, null]]) {
      expect(mergeEnrichment(base(), { categories: raw }, VOCAB).categories, JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('still lets a parse that carries categories win, and still asks nothing of an owner with none', () => {
    expect(mergeEnrichment(base({ categories: ['health'] }), { categories: 'leisure' }, VOCAB).categories).toEqual(['health']);
    expect(mergeEnrichment(base(), { categories: 'leisure' }, { directions: DIRECTIONS, others: [] }).categories).toBeUndefined();
    expect(mergeEnrichment(base(), { categories: 'leisure' }, { ...VOCAB, categories: [] }).categories).toBeUndefined();
  });

  it('puts the string pick on the category axis only, never on the tags', () => {
    const out = mergeEnrichment(base(), { categories: 'leisure', tags: 'email', direction: 'home' }, VOCAB);
    expect(out.categories).toEqual(['leisure']);
    expect(out.tags).toEqual(['home']); // direction only: a bare string for tags is still no tag
  });

  it('is the quick-add merge only: the shared constraining still accepts lists and nothing else', () => {
    // The memory fill-in, the Monday scorer, the tag suggester and the claim check call this directly.
    expect(constrainToVocabulary('leisure', VOCAB.categories, 3)).toEqual([]);
    expect(constrainToVocabulary(['leisure'], VOCAB.categories, 3)).toEqual(['leisure']);
  });
});

describe('enrichQuick on a bare-string answer', () => {
  beforeEach(() => { prompts.length = 0; reply.value = { direction: 'home', categories: 'leisure' }; });

  it('yields the category pick the model made, and asks the question exactly as it did before', async () => {
    const out = await enrichQuick('gym session', base(), VOCAB);
    expect(out.categories).toEqual(['leisure']);
    expect(prompts).toHaveLength(1); // the direction was valid: no second call
    // The prompt is the stock prompt: this line is the one it has always had.
    expect(prompts[0]).toContain('"categories": 1-3 life areas from ["health","Career","leisure","Health, Fitness"], best fit first.\n"tags":');
  });

  it('yields the same pick for a list, and none for a string naming nothing', async () => {
    reply.value = { direction: 'home', categories: ['leisure'] };
    expect((await enrichQuick('gym session', base(), VOCAB)).categories).toEqual(['leisure']);
    reply.value = { direction: 'home', categories: 'life areas' };
    expect((await enrichQuick('gym session', base(), VOCAB)).categories).toBeUndefined();
  });
});

describe('the wizard on a bare-string answer: preview, claim, Add, evidence', () => {
  const OWNER = SYSTEM_OWNER;
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => {
    resetDb();
    sqlite.exec('DELETE FROM classification_log;');
    const tag = sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, ?)`);
    for (const name of DIRECTIONS) tag.run(name, OWNER, 'direction');
    for (const name of ['health', 'leisure']) tag.run(name, OWNER, 'category');
    prompts.length = 0;
    reply.value = { direction: 'home', categories: 'leisure' };
  });

  const rows = () =>
    sqlite.prepare(`SELECT field, input_text, llm_value, final_value, corrected_at FROM classification_log WHERE owner_id = ?`)
      .all(OWNER) as { field: string; input_text: string; llm_value: string; final_value: string | null; corrected_at: string | null }[];

  it('shows the pick in the preview, offers it as a claim, and a changed pick on Add becomes a correction', async () => {
    const preview = await api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text: 'Gym session before work' } });
    expect(preview.status).toBe(200);
    expect(preview.body.llm).toBe(true);
    expect(preview.body.parsed.categories).toEqual(['leisure']);
    expect(preview.body.classification_claim).toEqual({ text: 'Gym session before work', categories: ['leisure'] });
    expect(rows()).toHaveLength(0); // the preview writes nothing

    // The owner changes the picker to health and presses Add, as the wizard sends it.
    const created = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: preview.body.parsed.title, categories: ['health'], classification_claim: preview.body.classification_claim },
    });
    expect(created.status).toBe(201);
    expect(rows()).toEqual([{
      field: 'category', input_text: 'Gym session before work', llm_value: 'leisure', final_value: 'health', corrected_at: expect.any(String),
    }]);
  });

  it('writes an open row when the owner keeps the pick', async () => {
    const preview = await api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text: 'Gym session before work' } });
    const created = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: preview.body.parsed.title, categories: ['leisure'], classification_claim: preview.body.classification_claim },
    });
    expect(created.status).toBe(201);
    expect(rows()).toEqual([{
      field: 'category', input_text: 'Gym session before work', llm_value: 'leisure', final_value: null, corrected_at: null,
    }]);
  });

  it('offers no claim when the string names no category of the owner', async () => {
    reply.value = { direction: 'home', categories: 'life areas' };
    const preview = await api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text: 'Gym session before work' } });
    expect(preview.status).toBe(200);
    expect(preview.body.parsed.categories).toBeUndefined();
    expect(preview.body.classification_claim).toBeUndefined();
  });

  it('still drops a claim the client sends as a bare string: the claim check takes lists only', async () => {
    const created = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Gym session before work', categories: ['health'], classification_claim: { text: 'Gym session before work', categories: 'leisure' } },
    });
    expect(created.status).toBe(201);
    expect(rows()).toHaveLength(0);
  });
});
