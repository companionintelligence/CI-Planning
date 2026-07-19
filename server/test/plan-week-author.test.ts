/**
 * FTUE · T9 (#345) — smart-week authoring: `POST /api/auto/run { smart: true }` orders
 * every horizon day via the LLM loop instead of the existing "day 0 smart, rest
 * deterministic" T-SCHED-2 split. Ollama mocked exactly like authoring-llm.test.ts;
 * horizon/placement setup mirrors sched-horizon.test.ts (workday shrunk to fit exactly
 * one task/day, so leftovers genuinely fan across days rather than draining on day 0).
 *
 * ⚠️ One assertion deliberately DIFFERS from the ticket's own Tests section. The ticket's
 * "smart off" case says to assert `result.llm !== true` while ALSO asserting day 0's
 * `source === 'llm'` — those two can't both hold: day 0 has always authored via the
 * pre-existing smart gate (`planning_mode==='smart' && isAvailable()`) independent of the
 * NEW `smart` flag (T-SCHED-2, unchanged by this ticket), and the DoD's own definition of
 * `AutoResult.llm` is "true iff AT LEAST ONE authored day returned `'llm'`" — day 0 alone
 * satisfies that. Implemented per the DoD's literal (and only unambiguous) definition;
 * the Tests section's specific assertion looks like an oversight, not a spec I can satisfy
 * simultaneously with the DoD and with pre-existing T-SCHED-2 behavior.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

const llmOrder = vi.fn<() => number[]>(() => []); // empty ⇒ safeOrder falls back to the deterministic index order (still stamped source='llm')
const rationaleResp = vi.fn<() => Record<string, string>>(() => ({}));
let ollamaUp = true;
let judgeOverall = 0.9;

vi.mock('../src/mcp/ollama.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/mcp/ollama.js')>();
  return {
    ...actual,
    isAvailable: vi.fn(async () => ollamaUp),
    generateJson: vi.fn(async (_prompt: string, opts?: { tier?: string; system?: string }) => {
      if (opts?.system?.includes('explain a finished day plan')) return rationaleResp();
      if (opts?.tier === 'medium') return { overall: judgeOverall, critique: 'looks coherent' };
      return llmOrder();
    }),
  };
});

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { authorPlanOrder } from '../src/agents/plan.js';

const OWNER = SYSTEM_OWNER;
const D0 = '2026-06-22'; // Mon
const D1 = '2026-06-23'; // Tue
const D2 = '2026-06-24'; // Wed

function insertTask(title: string, est = 45): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
      .get(title, OWNER, est) as { id: string }
  ).id;
}
function stage(id: string): void {
  sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, id);
}
function sourcesOn(date: string): string[] {
  return (sqlite.prepare(`SELECT source FROM daily_plan WHERE owner_id = ? AND date = ?`).all(OWNER, date) as { source: string }[]).map((r) => r.source);
}
function countOn(date: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) c FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1 AND start_at LIKE ?`).get(date + '%') as { c: number }).c;
}
function setSmartMode(): void {
  // Workday shrunk to fit exactly one 45-min task (sched-horizon.test.ts's exact window),
  // so a 5-task staged set genuinely fans across the 3-day horizon instead of draining
  // on day 0 — the only way to observe day 1/2 authoring at all.
  sqlite
    .prepare(`UPDATE scheduling_prefs SET planning_mode = 'smart', timezone = 'UTC', workday_start = '09:00', workday_end = '10:00' WHERE owner_id = ?`)
    .run(OWNER);
}
const stageFive = () => ['S1', 'S2', 'S3', 'S4', 'S5'].forEach((t) => stage(insertTask(t)));

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  setSmartMode();
  ollamaUp = true;
  judgeOverall = 0.9;
  llmOrder.mockReturnValue([]);
  rationaleResp.mockReturnValue({});
});

describe('POST /api/auto/run — T9 smart-week authoring', () => {
  it('smart:true authors every horizon day via the LLM loop', async () => {
    stageFive();
    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0, horizon_days: 3, smart: true } });
    expect(r.status).toBe(200);
    expect(r.body.result.days).toBe(3);
    expect(r.body.result.llm).toBe(true);
    for (const d of [D0, D1, D2]) {
      const s = sourcesOn(d);
      expect(s.length).toBeGreaterThan(0); // this day was actually authored
      expect(s.every((x) => x === 'llm')).toBe(true);
    }
  });

  it('smart absent keeps the T-SCHED-2 split: day 0 smart (unchanged, pre-existing), days 1-2 forced deterministic', async () => {
    stageFive();
    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0, horizon_days: 3 } });
    expect(r.status).toBe(200);
    expect(sourcesOn(D0).every((x) => x === 'llm')).toBe(true);
    expect(sourcesOn(D1).every((x) => x === 'deterministic')).toBe(true);
    expect(sourcesOn(D2).every((x) => x === 'deterministic')).toBe(true);
    // Day 0 alone makes this true under the DoD's literal definition — see the file header.
    expect(r.body.result.llm).toBe(true);
  });

  it('Ollama down ⇒ truthful llm:false, every day deterministic, no throw (200)', async () => {
    ollamaUp = false;
    stageFive();
    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0, horizon_days: 3, smart: true } });
    expect(r.status).toBe(200);
    expect(r.body.result.llm).toBe(false);
    for (const d of [D0, D1, D2]) expect(sourcesOn(d).every((x) => x === 'deterministic')).toBe(true);
  });

  it('is idempotent per day under smart:true — re-running does not stack auto blocks', async () => {
    stageFive();
    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0, horizon_days: 3, smart: true } });
    const first = [countOn(D0), countOn(D1), countOn(D2)];
    expect(first.every((n) => n === 1)).toBe(true);

    stageFive(); // re-stage the same still-open tasks and run again
    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0, horizon_days: 3, smart: true } });
    expect([countOn(D0), countOn(D1), countOn(D2)]).toEqual(first); // force re-authors the order, not the placement — still one block/day
  });
});

describe('authorPlanOrder — T9 return-value contract', () => {
  it('returns "llm" on a passing smart loop', async () => {
    const a = insertTask('A'); const b = insertTask('B');
    stage(a); stage(b);
    await expect(authorPlanOrder(OWNER, D0)).resolves.toBe('llm');
  });

  it('returns "deterministic" when Ollama is down', async () => {
    ollamaUp = false;
    const a = insertTask('A'); const b = insertTask('B');
    stage(a); stage(b);
    await expect(authorPlanOrder(OWNER, D0)).resolves.toBe('deterministic');
  });

  it('a no-op re-call (already authored, no force) returns the EXISTING persisted source truthfully, not void', async () => {
    const a = insertTask('A'); const b = insertTask('B');
    stage(a); stage(b);
    await expect(authorPlanOrder(OWNER, D0)).resolves.toBe('llm'); // first call authors via the LLM
    await expect(authorPlanOrder(OWNER, D0)).resolves.toBe('llm'); // no-op re-call — still reports 'llm', not undefined
  });
});
