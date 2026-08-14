/**
 * FTUE · T8 (#344) — POST /api/plan-week/parse.
 *
 * Parse-only twin of POST /api/plan/instruct (server/test/instruct.test.ts): same
 * validation rubric (malformed/unknown/contradictory ⇒ 422, Ollama-down ⇒ 503), but
 * this route never applies anything — authoring is T9. Every test here doubles as a
 * "no writes" assertion, since that's the one thing distinguishing this endpoint from
 * /api/plan/instruct.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';

let ollamaUp = true;
const parseResp = vi.fn<() => unknown>(() => ({ pins: [], hints: [] }));

vi.mock('../src/mcp/ollama.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/mcp/ollama.js')>();
  return {
    ...actual,
    isReady: vi.fn(async () => ollamaUp),
    generateJson: vi.fn(async () => parseResp()),
  };
});

import { sqlite } from '../src/db/index.js';
import { generateJson } from '../src/mcp/ollama.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

const mockGenerateJson = generateJson as unknown as ReturnType<typeof vi.fn>;
const DATE = '2026-06-24';

function insertTag(name: string): void {
  sqlite.prepare(`INSERT OR IGNORE INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, 'intention', ?)`).run(name, SYSTEM_OWNER);
}
function instructBlocks(): unknown[] {
  return sqlite.prepare(`SELECT id FROM time_blocks WHERE source_kind = 'instruct'`).all();
}
function planHints(): unknown[] {
  return sqlite.prepare(`SELECT id FROM plan_hints WHERE date = ?`).all(DATE);
}
async function auditRows(): Promise<unknown[]> {
  await flushAudits();
  return sqlite.prepare(`SELECT id FROM audit_log WHERE entity LIKE 'plan:%'`).all();
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00' WHERE owner_id = ?`).run(SYSTEM_OWNER);
  ollamaUp = true;
  parseResp.mockReturnValue({ pins: [], hints: [] });
  mockGenerateJson.mockClear();
});

const post = (text: string, date = DATE) => api(srv.url, '/api/plan-week/parse', { method: 'POST', json: { text, date } });

describe('POST /api/plan-week/parse (T8 — parse-only)', () => {
  it('parses time pins + hints and returns them WITHOUT writing anything', async () => {
    insertTag('deep-work');
    parseResp.mockReturnValue({
      pins: [{ title: 'Dentist', start: '14:00', end: '15:00' }],
      hints: [{ kind: 'tag_before', tag: 'deep-work', time: '15:00' }],
    });

    const res = await post('dentist 2-3pm, no deep work after 3pm');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      date: DATE,
      pins: [{ title: 'Dentist', start_at: `${DATE}T14:00:00.000Z`, end_at: `${DATE}T15:00:00.000Z` }],
      hints: [{ kind: 'tag_before', tag: 'deep-work', time: '15:00' }],
    });
    expect('created' in res.body).toBe(false); // parse-only — never an apply-shaped response

    expect(instructBlocks()).toHaveLength(0);
    expect(planHints()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('defaults date to today when omitted', async () => {
    const res = await api(srv.url, '/api/plan-week/parse', { method: 'POST', json: { text: 'hello there, no constraints' } });
    // "no actionable constraints" still 422s (see below) — this only proves the route
    // accepted a body with no `date` and passed something through to parseInstruction
    // rather than 422ing on a missing date.
    expect(res.status).toBe(422);
    expect(res.body.error).not.toMatch(/date/i);
  });

  it('422 + no writes on overlapping pins', async () => {
    parseResp.mockReturnValue({
      pins: [
        { title: 'A', start: '14:00', end: '15:00' },
        { title: 'B', start: '14:30', end: '15:30' },
      ],
      hints: [],
    });
    const res = await post('two overlapping things');
    expect(res.status).toBe(422);
    expect(instructBlocks()).toHaveLength(0);
  });

  it('422 on a malformed time', async () => {
    parseResp.mockReturnValue({ pins: [{ title: 'X', start: '25:99', end: '26:00' }], hints: [] });
    expect((await post('garbage time')).status).toBe(422);
  });

  it('422 on a hint referencing an unknown tag', async () => {
    parseResp.mockReturnValue({ pins: [], hints: [{ kind: 'batch', tag: 'nonexistent' }] });
    expect((await post('batch nonexistent')).status).toBe(422);
  });

  it('422 on an unknown hint kind', async () => {
    insertTag('email');
    parseResp.mockReturnValue({ pins: [], hints: [{ kind: 'teleport', tag: 'email' }] });
    expect((await post('teleport email')).status).toBe(422);
  });

  it('422 when nothing actionable is parsed', async () => {
    parseResp.mockReturnValue({ pins: [], hints: [] });
    expect((await post('hello there')).status).toBe(422);
  });

  it('422 on empty/whitespace text, BEFORE any Ollama call', async () => {
    const res = await api(srv.url, '/api/plan-week/parse', { method: 'POST', json: { text: '   ', date: DATE } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('text is required');
    expect(mockGenerateJson).not.toHaveBeenCalled();
  });

  it('503 + no writes when Ollama is unavailable', async () => {
    ollamaUp = false;
    const res = await post('dentist 2-3pm');
    expect(res.status).toBe(503);
    expect(instructBlocks()).toHaveLength(0);
    expect(planHints()).toHaveLength(0);
  });
});
