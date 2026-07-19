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
const rationaleResp = vi.fn<() => Record<string, string>>(() => ({ '0': 'Reason zero', '1': 'Reason one', '2': 'Reason two' }));
let ollamaUp = true;
let genThrows = false; // simulate Ollama failing MID-loop (after the pre-flight isAvailable() check)
let judgeOverall = 0.9; // lower this below the 0.8 pass threshold to force a loop stall (escape hatch)

vi.mock('../src/mcp/ollama.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/mcp/ollama.js')>();
  return {
    ...actual,
    isAvailable: vi.fn(async () => ollamaUp),
    generateJson: vi.fn(async (_prompt: string, opts?: { tier?: string; system?: string }) => {
      if (genThrows) throw new Error('ollama died mid-call'); // b4-1: timeout/OOM/dropped connection
      if (opts?.system?.includes('explain a finished day plan')) return rationaleResp(); // §A3 rationale call
      if (opts?.tier === 'medium') return { overall: judgeOverall, critique: 'looks coherent' };
      return llmOrder();
    }),
  };
});

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { authorPlanOrder } from '../src/agents/plan.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';
import { reflow } from '../src/engine/auto-defense.js';

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
    .prepare(`SELECT task_id, position, source, rationale FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`)
    .all(OWNER, DATE) as { task_id: string; position: number; source: string; rationale: string | null }[];
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
  genThrows = false;
  judgeOverall = 0.9;
  llmOrder.mockReturnValue([2, 0, 1]);
  rationaleResp.mockReturnValue({ '0': 'Reason zero', '1': 'Reason one', '2': 'Reason two' });
});

const auditCount = (action: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE owner_id = ? AND action = ?`).get(OWNER, action) as { n: number }).n;

describe('authorPlanOrder — robustness (b4-1, a0-1, a02-1)', () => {
  it('b4-1: an Ollama failure MID-loop degrades to deterministic, never throws', async () => {
    genThrows = true; // isAvailable() still true, but the first generate() call throws
    const a = insertTask('A'); const b = insertTask('B');
    stage(a, 0); stage(b, 1);

    await expect(authorPlanOrder(OWNER, DATE)).resolves.toBe('deterministic'); // no 500 / no throw, reports truthfully

    const rows = dailyPlanRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === 'deterministic')).toBe(true); // landed a valid order
  });

  it('a0-1: a stalled loop falls back to deterministic AND raises a visible plan_needs_review signal', async () => {
    judgeOverall = 0.1; // deterministic checks pass, but the judge never clears 0.8 → loop escapes
    const a = insertTask('A'); const b = insertTask('B'); const c = insertTask('C');
    stage(a, 0); stage(b, 1); stage(c, 2);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    expect(rows.every((r) => r.source === 'deterministic')).toBe(true); // escape hatch → deterministic
    expect(auditCount('plan_needs_review')).toBeGreaterThanOrEqual(1); // NOT a silent revert (§A0 clause 6)
  });

  it('a02-1: the real auditRecord sink writes plan_revision rows (default record path, not a stub)', async () => {
    const a = insertTask('A'); const b = insertTask('B');
    stage(a, 0); stage(b, 1);

    await authorPlanOrder(OWNER, DATE); // smart path, default record = auditRecord (no mock injected)

    expect(auditCount('plan_revision')).toBeGreaterThanOrEqual(1); // each loop revision is logged
  });
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

    await expect(authorPlanOrder(OWNER, DATE)).resolves.toBe('deterministic');

    const rows = dailyPlanRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === 'deterministic')).toBe(true);
    expect(rows.every((r) => r.rationale === null)).toBe(true); // §A3: no rationale when AI didn't author
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

  it("trust_mode='hands_off' activates the LLM path even when planning_mode='basic'", async () => {
    // Reset to basic so the activation comes purely from the trust dial.
    sqlite.prepare(`UPDATE scheduling_prefs SET planning_mode = 'basic', trust_mode = 'hands_off' WHERE owner_id = ?`).run(OWNER);

    const a = insertTask('A'); const b = insertTask('B'); const c = insertTask('C');
    stage(a, 0); stage(b, 1); stage(c, 2);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === 'llm')).toBe(true);
    expect(rows.map((r) => r.task_id)).toEqual([c, a, b]); // LLM order [2,0,1] ⇒ C,A,B
  });
});

describe('§A3 — per-task rationale', () => {
  it("writes one rationale per task (keyed by position) on the LLM path", async () => {
    const a = insertTask('A'); const b = insertTask('B'); const c = insertTask('C');
    stage(a, 0); stage(b, 1); stage(c, 2); // staged = [A,B,C]; LLM order [2,0,1] ⇒ C,A,B

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows(); // ordered by position
    expect(rows.map((r) => r.task_id)).toEqual([c, a, b]);
    expect(rows[0].rationale).toBe('Reason zero'); // position 0 → C
    expect(rows[1].rationale).toBe('Reason one'); // position 1 → A
    expect(rows[2].rationale).toBe('Reason two'); // position 2 → B
  });

  it('sanitizes rationales: drops blanks/non-strings, collapses whitespace, truncates >140', async () => {
    rationaleResp.mockReturnValue({ '0': '  Multi\n  line  reason  ', '1': '', '2': 'x'.repeat(200) });
    const a = insertTask('A'); const b = insertTask('B'); const c = insertTask('C');
    stage(a, 0); stage(b, 1); stage(c, 2);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows(); // C(pos0), A(pos1), B(pos2)
    expect(rows[0].rationale).toBe('Multi line reason'); // whitespace collapsed
    expect(rows[1].rationale).toBeNull(); // empty → null
    expect(rows[2].rationale!.length).toBe(140); // 139 chars + ellipsis
    expect(rows[2].rationale!.endsWith('…')).toBe(true);
  });

  it('surfaces the rationale on the placed block via the blocks API (block_id join), and re-links across reflow', async () => {
    const a = insertTask('A'); const b = insertTask('B'); const c = insertTask('C');
    stage(a, 0); stage(b, 1); stage(c, 2);
    await authorPlanOrder(OWNER, DATE); // C,A,B with rationales by position
    placeFlightPlan(OWNER, { date: DATE }); // links daily_plan.block_id

    const range = `from=${DATE}T00:00:00.000Z&to=${DATE}T23:59:59.999Z`;
    const res = await api(srv.url, `/api/blocks?${range}`);
    expect(res.status).toBe(200);
    const cBlock = res.body.blocks.find((bl: { task_id?: string }) => bl.task_id === c);
    expect(cBlock?.rationale).toBe('Reason zero'); // C is position 0

    // The rationale survives a reflow: block ids churn (reflow clears + re-places from
    // daily_plan), and daily_plan.block_id re-links to the fresh block.
    const beforeId = cBlock!.id;
    reflow(OWNER, DATE);
    const res2 = await api(srv.url, `/api/blocks?${range}`);
    const cBlock2 = res2.body.blocks.find((bl: { task_id?: string }) => bl.task_id === c);
    expect(cBlock2?.rationale).toBe('Reason zero');
    expect(cBlock2?.id).not.toBe(beforeId); // a genuinely new block — the rationale re-linked
  });
});
