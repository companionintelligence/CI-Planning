import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { enrichQuick } from '../src/agents/quickadd.js';
import { parseQuick } from '../src/engine/quickadd.js';
import { suggestibleVocabulary } from '../src/services/tags.js';
import { ollama } from '../src/mcp/ollama.js';

/**
 * The classification hint, as the two quick-add ROUTES hand it to the real `enrichQuick`.
 *
 * `quickadd-hint-prompt.test.ts` pins the prompt `enrichQuick` builds from a hint it is
 * given; `classification-quickadd.test.ts` stubs `enrichQuick` and reads the hints the
 * routes pass. This file closes the gap between them: real routes, real `enrichQuick`,
 * real exemplar rows, and the model seam (`generateJson`) stubbed so the PROMPT that
 * would reach the model is the thing asserted. An owner with no corrections must be shown
 * today's prompt byte for byte on BOTH routes, and one owner's corrections must never be
 * shown to another.
 *
 * Partial mock, not a wholesale replacement: only the model seam may be stubbed.
 */
const { prompts, reply } = vi.hoisted(() => ({
  prompts: [] as string[],
  // Includes a direction, so the second-chance call stays quiet unless a test removes it.
  reply: { value: { direction: 'work', categories: ['leisure'], motivation: 'me', tags: [] } as Record<string, unknown> },
}));
vi.mock('../src/mcp/ollama.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mcp/ollama.js')>()),
  generateJson: async (prompt: string) => {
    prompts.push(prompt);
    return reply.value;
  },
}));

const OWNER = SYSTEM_OWNER;
const TEXT = 'gym session before work';

/** Both routes take the same body and must hand the model the same prompt. */
const ROUTES = [
  { name: 'POST /api/tasks/quick/parse', path: '/api/tasks/quick/parse' },
  { name: 'POST /api/tasks/quick', path: '/api/tasks/quick' },
] as const;

function tag(name: string, kind: 'category' | 'direction' | 'intention', owner = OWNER): void {
  sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, ?)`).run(name, owner, kind);
}

/** One index row written directly (embedding NULL: quick-add reads the frequency path). */
let rowSeq = 0;
function exemplar(o: { field: 'category' | 'motivation'; text: string; llm: string; correct: string; owner?: string }): void {
  sqlite.prepare(
    `INSERT INTO classification_exemplars (owner_id, field, log_id, input_text, llm_value, correct_value, embedding, computed_date)
     VALUES (?, ?, ?, ?, ?, ?, NULL, '2026-11-02')`,
  ).run(o.owner ?? OWNER, o.field, `hint-${String(rowSeq++).padStart(4, '0')}`, o.text, o.llm, o.correct);
}

// The two prompts `enrichQuick` can send, told apart by their opening words so that a
// stray model call from anywhere else in the server cannot be mistaken for either.
const mains = () => prompts.filter((p) => p.startsWith('Classify this quick task entry'));
const retries = () => prompts.filter((p) => p.startsWith('Which area of life does this task belong to?'));

/** The classification prompt a request put in front of the model. */
async function promptFrom(path: string, text = TEXT, headers: Record<string, string> = {}): Promise<string> {
  prompts.length = 0;
  const res = await api(srv.url, path, { method: 'POST', json: { text }, headers });
  expect([200, 201]).toContain(res.status);
  expect(mains()).toHaveLength(1);
  return mains()[0];
}

/** What `enrichQuick` builds for the same entry with NO hints: the pre-hint prompt. */
async function stockPrompt(text = TEXT, owner = OWNER): Promise<string> {
  prompts.length = 0;
  await enrichQuick(text, parseQuick(text), await suggestibleVocabulary(owner));
  return mains()[0];
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => {
  await srv.close();
  // Leave no index rows or tags behind for a file that does not reset the database itself.
  resetDb();
});
beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM classification_log; DELETE FROM classification_exemplars;');
  rowSeq = 0;
  prompts.length = 0;
  reply.value = { direction: 'work', categories: ['leisure'], motivation: 'me', tags: [] };
  // A full vocabulary, so every line the hints could sit beside is actually in the prompt.
  tag('health', 'category');
  tag('leisure', 'category');
  tag('work', 'direction');
  tag('home', 'direction');
  tag('email', 'intention');
});

describe('an owner with no corrections', () => {
  for (const route of ROUTES) {
    it(`is shown exactly today's prompt on ${route.name}`, async () => {
      const viaRoute = await promptFrom(route.path);
      const direct = await stockPrompt();
      expect(viaRoute).toBe(direct);
      // Not vacuous: the lines a hint would sit beside are really there, and nothing is.
      expect(direct).toContain('"categories": 1-3 life areas from ["health","leisure"]');
      expect(direct).toContain('"motivation": one of "me","us","them", or null.');
      expect(viaRoute).not.toContain('corrected you before');
      // Today's prompt has no blank line in it at all; a hint block is the only thing that
      // brings one, so a stray newline for an EMPTY hint cannot hide behind the equality
      // above (the direct call would carry it too).
      expect(viaRoute).not.toMatch(/\n\n/);
    });
  }

  it('is shown today’s prompt on both routes when ONLY another owner has corrections', async () => {
    createOwner(SECOND_OWNER_ID);
    tag('health', 'category', SECOND_OWNER_ID);
    tag('leisure', 'category', SECOND_OWNER_ID);
    exemplar({ field: 'category', text: 'salsa class', llm: 'health', correct: 'leisure', owner: SECOND_OWNER_ID });
    exemplar({ field: 'motivation', text: 'drive gran to church', llm: 'me', correct: 'them', owner: SECOND_OWNER_ID });

    const stock = await stockPrompt();
    for (const route of ROUTES) {
      const seen = await promptFrom(route.path);
      expect(seen).toBe(stock);
      expect(seen).not.toContain('salsa class');
      expect(seen).not.toContain('drive gran to church');
    }
  });

  it('is shown today’s prompt again once the owner resets the learned index', async () => {
    exemplar({ field: 'category', text: 'gym session before work', llm: 'leisure', correct: 'health' });
    expect(await promptFrom('/api/tasks/quick/parse')).toContain('you said leisure; the user chose health');

    const reset = await api(srv.url, '/api/classification/exemplars', { method: 'DELETE' });
    expect(reset.status).toBe(200);

    const stock = await stockPrompt();
    for (const route of ROUTES) expect(await promptFrom(route.path)).toBe(stock);
  });
});

describe('an owner with corrections', () => {
  beforeEach(() => {
    exemplar({ field: 'category', text: 'gym session before work', llm: 'leisure', correct: 'health' });
    exemplar({ field: 'motivation', text: 'help mum with her taxes', llm: 'me', correct: 'them' });
  });

  for (const route of ROUTES) {
    it(`sees each lesson right after the field it governs on ${route.name}`, async () => {
      const prompt = await promptFrom(route.path, 'water the plants');
      const at = {
        motivation: prompt.indexOf('"motivation": one of'),
        motivationLesson: prompt.indexOf('you said me; the user chose them.'),
        categories: prompt.indexOf('"categories": 1-3 life areas'),
        categoryLesson: prompt.indexOf('you said leisure; the user chose health.'),
        tags: prompt.indexOf('"tags": up to 2'),
      };
      for (const [name, i] of Object.entries(at)) expect(i, name).toBeGreaterThan(-1);
      expect(at.motivation).toBeLessThan(at.motivationLesson);
      expect(at.motivationLesson).toBeLessThan(at.categories);
      expect(at.categories).toBeLessThan(at.categoryLesson);
      expect(at.categoryLesson).toBeLessThan(at.tags);

      // A blank line on both sides keeps a block from reading as a continuation of the next field.
      expect(prompt).toContain('you said me; the user chose them.\n\n"categories"');
      expect(prompt).toContain('you said leisure; the user chose health.\n\n"tags"');
      expect(prompt.split('\n\nThis user has corrected you before')).toHaveLength(3);

      // Each lesson once, the rule that follows the list stays last, and the entry is the tail.
      expect(prompt.split('you said me; the user chose them.')).toHaveLength(2);
      expect(prompt.split('you said leisure; the user chose health.')).toHaveLength(2);
      expect(prompt.split('corrected you before')).toHaveLength(3);
      expect(prompt.endsWith('never invent.\nEntry: "water the plants"')).toBe(true);
    });
  }

  it('is shown the same prompt by both routes, which share one fetch', async () => {
    const viaParse = await promptFrom('/api/tasks/quick/parse');
    const viaQuick = await promptFrom('/api/tasks/quick');
    expect(viaQuick).toBe(viaParse);
    // …and it is a different prompt from the stock one, so the equality above is about
    // the hint and not about two routes that both ignore it.
    sqlite.exec('DELETE FROM classification_exemplars');
    expect(viaParse).not.toBe(await stockPrompt());
  });

  it('gets no lesson for a category line that is not asked', async () => {
    // No category tags: the categories line is not in the prompt, so a lesson about it
    // would have nothing to govern. The motivation lesson is unaffected.
    sqlite.exec(`DELETE FROM tags WHERE kind = 'category'`);
    for (const route of ROUTES) {
      const prompt = await promptFrom(route.path);
      expect(prompt).not.toContain('"categories"');
      expect(prompt).not.toContain('the user chose health');
      expect(prompt).toContain('you said me; the user chose them.');
    }
  });

  it('is not offered a value that is not on its current list', async () => {
    // Three distinct out-of-list values outrank the one valid lesson by frequency, so this
    // fails unless the list is applied BEFORE the cut and not after it.
    sqlite.exec('DELETE FROM classification_exemplars');
    for (const gone of ['gardening', 'gardening', 'gardening', '', '', 'cooking', 'cooking']) {
      exemplar({ field: 'category', text: `old lesson ${rowSeq}`, llm: 'leisure', correct: gone });
    }
    exemplar({ field: 'category', text: 'gym session before work', llm: 'leisure', correct: 'health' });
    for (const route of ROUTES) {
      const prompt = await promptFrom(route.path);
      expect(prompt).toContain('you said leisure; the user chose health.');
      expect(prompt).not.toContain('gardening');
      expect(prompt).not.toContain('cooking');
      expect(prompt).not.toContain('(nothing)');
    }
  });

  it('keeps a lesson that names several categories, whatever their casing, only if all are on the list', async () => {
    sqlite.exec('DELETE FROM classification_exemplars');
    exemplar({ field: 'category', text: 'gym then a long walk', llm: 'leisure', correct: 'Health, Leisure' });
    exemplar({ field: 'category', text: 'gym then gardening', llm: 'leisure', correct: 'health, gardening' });
    const prompt = await promptFrom('/api/tasks/quick/parse');
    expect(prompt).toContain('the user chose Health, Leisure.');
    expect(prompt).not.toContain('gym then gardening');
  });

  it('holds the motivation lesson to me, us and them', async () => {
    sqlite.exec('DELETE FROM classification_exemplars');
    for (let i = 0; i < 3; i++) exemplar({ field: 'motivation', text: `odd lesson ${i}`, llm: 'me', correct: 'zebra' });
    exemplar({ field: 'motivation', text: 'help mum with her taxes', llm: 'me', correct: 'them' });
    for (const route of ROUTES) {
      const prompt = await promptFrom(route.path);
      expect(prompt).toContain('you said me; the user chose them.');
      expect(prompt).not.toContain('zebra');
    }
  });

  it('never gives the direction retry a lesson', async () => {
    // No direction in the first answer, so the single-field retry fires.
    reply.value = { categories: ['leisure'], motivation: 'me', tags: [] };
    const hinted = await promptFrom('/api/tasks/quick/parse');
    expect(hinted).toContain('corrected you before');
    expect(retries()).toHaveLength(1);
    const retry = retries()[0];
    expect(retry).not.toContain('corrected you before');
    expect(retry).not.toContain('the user chose');

    // …and it is the very retry an owner with no corrections gets.
    sqlite.exec('DELETE FROM classification_exemplars');
    await promptFrom('/api/tasks/quick/parse');
    expect(retries()).toEqual([retry]);
  });

  it('never waits on the embedder', async () => {
    // Interactive latency: a person is watching the spinner, and an embed can evict the
    // classify model. Quick-add takes the frequency path without so much as asking.
    const ready = vi.spyOn(ollama, 'embedReady').mockResolvedValue(true);
    const embed = vi.spyOn(ollama, 'embed').mockRejectedValue(new Error('should not be called'));
    try {
      for (const route of ROUTES) {
        const prompt = await promptFrom(route.path);
        expect(prompt).toContain('the user chose health');
      }
      expect(ready).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    } finally {
      ready.mockRestore();
      embed.mockRestore();
    }
  });
});

describe('two owners', () => {
  beforeEach(() => {
    createOwner(SECOND_OWNER_ID);
    tag('health', 'category', SECOND_OWNER_ID);
    tag('leisure', 'category', SECOND_OWNER_ID);
    exemplar({ field: 'category', text: 'gym session before work', llm: 'leisure', correct: 'health' });
    exemplar({ field: 'motivation', text: 'help mum with her taxes', llm: 'me', correct: 'them' });
    exemplar({ field: 'category', text: 'salsa class', llm: 'health', correct: 'leisure', owner: SECOND_OWNER_ID });
    exemplar({ field: 'motivation', text: 'drive gran to church', llm: 'me', correct: 'us', owner: SECOND_OWNER_ID });
  });

  for (const route of ROUTES) {
    it(`keep their corrections to themselves on ${route.name}`, async () => {
      // An entry that is neither owner's lesson text, so a hit can only be a leak.
      const entry = 'water the plants';
      const first = await promptFrom(route.path, entry);
      expect(first).toContain('you said leisure; the user chose health.');
      expect(first).toContain('you said me; the user chose them.');
      expect(first).not.toContain('salsa class');
      expect(first).not.toContain('drive gran to church');

      const second = await promptFrom(route.path, entry, { 'x-test-owner': SECOND_OWNER_ID });
      expect(second).toContain('you said health; the user chose leisure.');
      expect(second).toContain('you said me; the user chose us.');
      expect(second).not.toContain('gym session before work');
      expect(second).not.toContain('help mum with her taxes');
    });
  }
});
