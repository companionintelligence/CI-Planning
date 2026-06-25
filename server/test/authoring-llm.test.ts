/**
 * Phase M §0 / A1 — the LLM authoring path, exercised with a mocked Ollama so it
 * runs in CI (where Ollama is absent). Covers the spec's §0 test-list items:
 *   • "daily_plan written by LLM order"  → a passing loop persists source='llm'
 *     in the LLM's permutation, not the deterministic order.
 *   • "Ollama-down ⇒ deterministic fallback, no throw" → isAvailable()=false falls
 *     back to source='deterministic'.
 *
 * The mock branches on the generate tier: 'medium' = judge (score object),
 * 'small' = generate/revise (index permutation).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

const llmOrder = vi.fn<() => number[]>(() => [2, 0, 1]); // C, A, B — a non-deterministic permutation
let ollamaUp = true;

vi.mock('../src/mcp/ollama.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/mcp/ollama.js')>();
  return {
    ...actual,
    isAvailable: vi.fn(async () => ollamaUp),
    generateJson: vi.fn(async (_prompt: string, opts?: { tier?: string }) => {
      if (opts?.tier === 'medium') return { overall: 0.9, critique: 'looks coherent' };
      return llmOrder();
    }),
  };
});

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';
import { authorPlanOrder } from '../src/agents/plan.js';

const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-24';

function insertTask(title: string): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES (uuid7(), ?, ?, 'open', 3) RETURNING id`)
      .get(title, OWNER) as { id: string }
  ).id;
}

function stage(taskId: string, position: number): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`)
    .run(OWNER, taskId, position);
}

function dailyPlanRows() {
  return sqlite
    .prepare(`SELECT task_id, position, source FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`)
    .all(OWNER, DATE) as { task_id: string; position: number; source: string }[];
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan`);
  sqlite.exec(`DELETE FROM daily_plan WHERE owner_id = '${OWNER}'`);
  sqlite.prepare(`UPDATE scheduling_prefs SET planning_mode = 'smart', timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
  ollamaUp = true;
  llmOrder.mockReturnValue([2, 0, 1]);
});

describe('authorPlanOrder — LLM path (mocked Ollama)', () => {
  it("persists the LLM's order with source='llm' when the loop passes", async () => {
    // Equal priority + no due dates ⇒ many orders pass checkOrder, so the LLM's
    // permutation survives and is distinguishable from the deterministic (by-id) order.
    const a = insertTask('A'); const b = insertTask('B'); const c = insertTask('C');
    stage(a, 0); stage(b, 1); stage(c, 2); // staged = [A, B, C]

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === 'llm')).toBe(true);
    // LLM returned indices [2,0,1] over staged [A,B,C] ⇒ C, A, B.
    expect(rows.map((r) => r.task_id)).toEqual([c, a, b]);
  });

  it('falls back to source=deterministic (no throw) when Ollama is down', async () => {
    ollamaUp = false;
    const a = insertTask('A'); const b = insertTask('B');
    stage(a, 0); stage(b, 1);

    await expect(authorPlanOrder(OWNER, DATE)).resolves.toBeUndefined();

    const rows = dailyPlanRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === 'deterministic')).toBe(true);
  });

  it('never drops a task even if the LLM omits indices (safeOrder appends the rest)', async () => {
    llmOrder.mockReturnValue([1]); // LLM returns only one of three indices
    const a = insertTask('A'); const b = insertTask('B'); const c = insertTask('C');
    stage(a, 0); stage(b, 1); stage(c, 2);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.task_id))).toEqual(new Set([a, b, c]));
    expect(rows[0].task_id).toBe(b); // the one index the LLM did return leads
  });
});
