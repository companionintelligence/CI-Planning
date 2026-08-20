/**
 * Phase M A4 (pins-first) — POST /api/plan/instruct.
 *
 * Ollama is mocked so the parse runs in CI. The rubric is pure schema validation:
 * malformed/unknown/contradictory ⇒ 422 with NO writes; Ollama-down ⇒ 503. Valid
 * time pins become locked 'meeting' obstacle blocks; hints are returned, not enforced.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

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
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

const DATE = '2026-06-24';

function insertTag(name: string): void {
  sqlite.prepare(`INSERT OR IGNORE INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, 'intention', ?)`).run(name, SYSTEM_OWNER);
}
function instructBlocks(): { title: string; start_at: string; end_at: string; is_locked: number; block_kind: string }[] {
  return sqlite
    .prepare(`SELECT title, start_at, end_at, is_locked, block_kind FROM time_blocks WHERE source_kind = 'instruct' ORDER BY start_at`)
    .all() as { title: string; start_at: string; end_at: string; is_locked: number; block_kind: string }[];
}
function planHints(): { kind: string; tag: string; time: string | null }[] {
  return sqlite
    .prepare(`SELECT kind, tag, time FROM plan_hints WHERE date = ? ORDER BY kind, tag`)
    .all(DATE) as { kind: string; tag: string; time: string | null }[];
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(SYSTEM_OWNER);
  ollamaUp = true;
  parseResp.mockReturnValue({ pins: [], hints: [] });
});

const post = (text: string) => api(srv.url, '/api/plan/instruct', { method: 'POST', json: { text, date: DATE } });

describe('POST /api/plan/instruct (A4 pins-first)', () => {
  it('applies time pins as locked meeting blocks and returns parsed hints', async () => {
    insertTag('deep-work');
    parseResp.mockReturnValue({
      pins: [{ title: 'Dentist', start: '14:00', end: '15:00' }],
      hints: [{ kind: 'tag_before', tag: 'deep-work', time: '15:00' }],
    });

    const res = await post('dentist 2-3pm, no deep work after 3pm');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.hints).toEqual([{ kind: 'tag_before', tag: 'deep-work', time: '15:00' }]);

    const blocks = instructBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe('Dentist');
    expect(blocks[0].is_locked).toBe(1);
    expect(blocks[0].block_kind).toBe('meeting');
    expect(blocks[0].start_at).toBe(`${DATE}T14:00:00.000Z`);
    expect(blocks[0].end_at).toBe(`${DATE}T15:00:00.000Z`);

    // The hint is persisted so a later autoplan run can enforce it (A4 enforcement).
    expect(planHints()).toEqual([{ kind: 'tag_before', tag: 'deep-work', time: '15:00' }]);
  });

  it('persists hints even with no pins, and is idempotent across a repeated instruct', async () => {
    insertTag('errands');
    parseResp.mockReturnValue({ pins: [], hints: [{ kind: 'tag_after', tag: 'errands', time: '12:00' }] });

    const res = await post('no errands before noon');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(planHints()).toEqual([{ kind: 'tag_after', tag: 'errands', time: '12:00' }]);

    // Same instruction again → INSERT OR IGNORE against the dedupe index → still one row.
    await post('no errands before noon');
    expect(planHints()).toHaveLength(1);
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
    expect(instructBlocks()).toHaveLength(0); // no partial write
  });

  it('422 on a malformed time', async () => {
    parseResp.mockReturnValue({ pins: [{ title: 'X', start: '25:99', end: '26:00' }], hints: [] });
    const res = await post('garbage time');
    expect(res.status).toBe(422);
    expect(instructBlocks()).toHaveLength(0);
  });

  it('422 on a hint referencing an unknown tag — and the valid pin is NOT written (no partial apply)', async () => {
    parseResp.mockReturnValue({
      pins: [{ title: 'Standup', start: '09:00', end: '09:30' }], // valid
      hints: [{ kind: 'batch', tag: 'nonexistent' }], // invalid → whole request rejected
    });
    const res = await post('standup 9, batch nonexistent');
    expect(res.status).toBe(422);
    expect(instructBlocks()).toHaveLength(0); // the valid pin must NOT have been created
    expect(planHints()).toHaveLength(0);      // …nor any hint (no partial apply)
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

  it('422 on empty text (before any LLM call)', async () => {
    expect((await api(srv.url, '/api/plan/instruct', { method: 'POST', json: { text: '   ' } })).status).toBe(422);
  });

  it('503 + no writes when Ollama is unavailable', async () => {
    ollamaUp = false;
    const res = await post('dentist 2-3pm');
    expect(res.status).toBe(503);
    expect(instructBlocks()).toHaveLength(0);
  });
});
