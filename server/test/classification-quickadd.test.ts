import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

/**
 * Phase 8 capture on the QUICK-ADD path — the one the plan calls "input → task parse",
 * and the path most classifications actually come from.
 *
 * The seam is `enrichQuick`, stubbed here so the model's pick is a fact of the fixture.
 * Partial mock, not a wholesale replacement: the route imports other things from this
 * module, and only the model seam may be stubbed.
 */
const { overlay } = vi.hoisted(() => ({ overlay: { value: null as Record<string, unknown> | null } }));

vi.mock('../src/agents/quickadd.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agents/quickadd.js')>()),
  enrichQuick: async (_text: string, parsed: Record<string, unknown>) => {
    // null = the model was unavailable, which the route catches and treats as
    // "deterministic parse only" (llm: false).
    if (overlay.value === null) throw new Error('OllamaUnavailable');
    return { ...parsed, ...overlay.value };
  },
}));

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
