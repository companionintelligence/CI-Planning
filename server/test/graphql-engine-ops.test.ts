import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { config } from '../src/lib/config.js';

/**
 * Phase W · W13 — mutation-only engine ops end-to-end over HTTP. Proves each GraphQL op is
 * a thin caller over the SAME engine functions the REST routes drive (cross-checked via
 * REST GET /api/blocks + /api/flight-plan), through services/engine-ops.ts. Covers:
 * runSchedule reflow, instructPlan error mapping (empty-text → BAD_USER_INPUT; LLM-off →
 * SERVICE_UNAVAILABLE — the endpoint is pinned to a closed port for this file, so
 * isAvailable() is false and parseInstruction throws InstructError('unavailable')),
 * planSuggestion query, reauthorPlan/dismissReauthor
 * (suggestion clears), autoFill/autoRun/autoPriority/autoUndo (blocks placed + flightPlan
 * drains + the returned flightPlan uses FlightPlanEntryType), clearPlanner (bad dates →
 * BAD_USER_INPUT, dry-run report, real apply deletes + REST cross-check), and cross-owner
 * isolation (an op run as SECOND_OWNER_ID never touches owner A's plan).
 *
 * LLM ISOLATION: this file deliberately uses no Ollama mock — the point is to drive the
 * real engine path end-to-end — but "no mock" is NOT the same as "no model". On a dev box
 * running Ollama on the default 127.0.0.1:11434, isAvailable() is true, instructPlan reaches
 * a real model and returns { ok: true, created: 1 }, and the LLM-unavailable test fails
 * (and writes a time_blocks row, breaking its "no writes" half too). So pin config.ollamaUrl
 * at a closed port for the file's duration — the same trick video/README.md uses — which
 * makes "unreachable" true by construction instead of an accident of the host. Mutating the
 * config singleton, not process.env.OLLAMA_URL: config.ts reads env once at import, and ESM
 * hoists that import above anything this file could set first. Every consumer reads
 * `${config.ollamaUrl}` at call time (src/mcp/ollama.ts), so the pin takes effect live.
 */
const CLOSED_PORT_URL = 'http://127.0.0.1:1';
let realOllamaUrl: string;

let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
  return { status: res.status, body };
}

/** An open, estimate-bearing, untagged task → placeable via the workday fallback. */
function insertTask(title: string, owner = OWNER, est = 60): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
    .get(title, owner, est) as { id: string }).id;
}
function stageTask(taskId: string, owner = OWNER): void {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(owner, taskId);
}
function autoBlockCount(owner = OWNER): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE owner_id = ? AND block_kind = 'task' AND is_auto = 1`).get(owner) as { n: number }).n;
}
function fpCount(owner = OWNER): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ?`).get(owner) as { n: number }).n;
}
function seedSuggestion(owner = OWNER, date = '2026-06-24'): void {
  sqlite
    .prepare(`INSERT OR REPLACE INTO replan_suggestions (owner_id, date, reason, summary, at_risk) VALUES (?, ?, 'delete', '2 priority tasks at risk', 2)`)
    .run(owner, date);
}
function suggestionCount(owner = OWNER): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM replan_suggestions WHERE owner_id = ?`).get(owner) as { n: number }).n;
}
function auditCount(action: string, owner = OWNER): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE owner_id = ? AND action = ?`).get(owner, action) as { n: number }).n;
}

const DATE = '2026-06-24';

// Recurring instances materialize lazily within a horizon relative to *now*, so the
// clearPlanner tests use today-relative days (mirrors planner-clear-route.test.ts).
const pad = (n: number) => String(n).padStart(2, '0');
const BASE = new Date();
const isoDay = (o: number) => {
  const d = new Date(BASE);
  d.setUTCDate(d.getUTCDate() + o);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const T0 = isoDay(0), T2 = isoDay(2), T4 = isoDay(4);

beforeAll(async () => {
  realOllamaUrl = config.ollamaUrl;
  config.ollamaUrl = CLOSED_PORT_URL; // see LLM ISOLATION above — pin before the app boots
  srv = await startTestServer();
});
afterAll(async () => {
  config.ollamaUrl = realOllamaUrl;
  await srv.close();
});
beforeEach(() => {
  resetDb(); // UTC, workday 09:00-18:00, horizon 7
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM replan_suggestions; DELETE FROM audit_log;`);
});

describe('W13 — runSchedule', () => {
  it('reflows deterministically and returns a diff (no error)', async () => {
    const r = await gql(`mutation { runSchedule(date: "${DATE}") { diff success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.runSchedule.success).toBe(true);
    // ReflowDiff has the four arrays even when nothing moved.
    expect(r.body.data.runSchedule.diff).toMatchObject({ moved: [], removed: [], added: [], unplaced: [] });
    expect(auditCount('run')).toBe(1); // schedule:${date}
  });
});

describe('W13 — instructPlan error mapping', () => {
  it('empty text → BAD_USER_INPUT (before any LLM call)', async () => {
    const r = await gql(`mutation { instructPlan(input: { text: "   " }) { ok created } }`);
    expect(r.body.data?.instructPlan ?? null).toBeNull();
    expect(r.body.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(r.body.errors?.[0].message).toMatch(/text is required/);
  });

  it('LLM unavailable → SERVICE_UNAVAILABLE + no writes', async () => {
    // config.ollamaUrl is pinned to a closed port for this file (see LLM ISOLATION in the
    // header) → isAvailable() is false → parseInstruction throws InstructError('unavailable')
    // → the resolver maps it to SERVICE_UNAVAILABLE. Do NOT rely on the host simply not
    // running Ollama: with one up on the default port this reaches a real model and returns
    // { ok: true, created: 1 }, failing both halves of the assertion.
    expect(config.ollamaUrl).toBe(CLOSED_PORT_URL);
    const before = (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks`).get() as { n: number }).n;
    const r = await gql(`mutation { instructPlan(input: { text: "dentist 2-3pm", date: "${DATE}" }) { ok created } }`);
    expect(r.body.data?.instructPlan ?? null).toBeNull();
    expect(r.body.errors?.[0].extensions?.code).toBe('SERVICE_UNAVAILABLE');
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks`).get() as { n: number }).n).toBe(before); // no partial write
  });
});

describe('W13 — planSuggestion / reauthor / dismiss', () => {
  it('planSuggestion returns null when none outstanding, the seeded nudge otherwise', async () => {
    const empty = await gql(`{ planSuggestion { date reason summary atRisk } }`);
    expect(empty.body.errors).toBeUndefined();
    expect(empty.body.data.planSuggestion).toBeNull();

    seedSuggestion(OWNER, DATE);
    const got = await gql(`{ planSuggestion { date reason summary atRisk } }`);
    expect(got.body.data.planSuggestion).toMatchObject({ date: DATE, reason: 'delete', atRisk: 2 });
  });

  it('reauthorPlan clears the outstanding suggestion and returns a diff', async () => {
    seedSuggestion(OWNER, DATE);
    expect(suggestionCount()).toBe(1);
    const r = await gql(`mutation { reauthorPlan(date: "${DATE}") { diff success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.reauthorPlan.success).toBe(true);
    expect(suggestionCount()).toBe(0); // cleared
    expect(auditCount('reauthor')).toBe(1);
  });

  it('dismissReauthor clears the suggestion', async () => {
    seedSuggestion(OWNER, DATE);
    const r = await gql(`mutation { dismissReauthor { success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.dismissReauthor.success).toBe(true);
    expect(suggestionCount()).toBe(0);
    expect(auditCount('dismiss')).toBe(1);
  });
});

describe('W13 — auto ops', () => {
  it('autoFill proposes candidates into staging (step=fill) + reuses FlightPlanEntryType', async () => {
    insertTask('Alpha');
    insertTask('Beta');
    const r = await gql(`mutation { autoFill { result flightPlan { id task { id title } selected sourceKind } success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.autoFill.result.step).toBe('fill');
    expect(r.body.data.autoFill.result.candidatesAdded).toBe(2);
    // The returned flightPlan is FlightPlanEntryType (id = staged task id, task resolved).
    expect(r.body.data.autoFill.flightPlan).toHaveLength(2);
    expect(r.body.data.autoFill.flightPlan[0].task.id).toBe(r.body.data.autoFill.flightPlan[0].id);
    expect(auditCount('fill')).toBe(1);
  });

  it('autoRun places a staged task, drains the flight plan (cross-checked via REST)', async () => {
    const t = insertTask('Write report');
    stageTask(t);
    const r = await gql(`mutation { autoRun(input: { date: "${DATE}" }) { result flightPlan { id } success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.autoRun.result.step).toBe('place');
    expect(r.body.data.autoRun.result.placed).toBeGreaterThanOrEqual(1);
    expect(autoBlockCount()).toBeGreaterThanOrEqual(1); // a block was created

    // REST cross-check: the placed task is drained from the flight plan.
    const fp = (await api(srv.url, '/api/flight-plan')).body.flight_plan;
    expect(fp.find((x: any) => x.task_id === t)).toBeUndefined();
    expect(r.body.data.autoRun.flightPlan.find((e: any) => e.id === t)).toBeUndefined();
  });

  /**
   * T9 — REST/GraphQL parity for the `smart` flag. `smart: true` still lands on the
   * deterministic path here for TWO independent reasons: the endpoint is pinned to a closed
   * port (see LLM ISOLATION in the header), and the gate is
   * `!opts.deterministic && planning_mode === 'smart'` (agents/plan.ts) while these owners
   * default to 'basic' — so the isAvailable() half is short-circuited anyway. The point of
   * this test is that the GraphQL resolver actually forwards `input.smart` through to
   * `autoRun` (a typo in `input.smart ?? undefined` wouldn't be caught by the REST test
   * alone) and that both transports surface the same `llm` field, truthfully false when
   * Ollama is unreachable.
   */
  it('autoRun forwards the smart flag through GraphQL and REST identically', async () => {
    const t1 = insertTask('GraphQL smart run');
    stageTask(t1);
    const gqlResult = await gql(`mutation { autoRun(input: { date: "${DATE}", smart: true }) { result flightPlan { id } success } }`);
    expect(gqlResult.body.errors).toBeUndefined();
    expect(gqlResult.body.data.autoRun.result.llm).toBe(false); // Ollama unreachable in this suite

    const t2 = insertTask('REST smart run');
    stageTask(t2);
    const restResult = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: DATE, smart: true } });
    expect(restResult.body.result.llm).toBe(false);
  });

  it('autoPriority tops up workday capacity with unplaced tasks', async () => {
    const t = insertTask('Priority placed');
    stageTask(t);
    const r = await gql(`mutation { autoPriority(date: "${DATE}") { result flightPlan { id } success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.autoPriority.result.blocksCreated).toBeGreaterThanOrEqual(1);
    expect(auditCount('run')).toBe(1); // flight-plan:priority
  });

  it('autoUndo removes the last placement run and re-stages its tasks', async () => {
    const t = insertTask('Undo me');
    stageTask(t);
    await gql(`mutation { autoRun(input: { date: "${DATE}" }) { success } }`);
    expect(autoBlockCount()).toBeGreaterThanOrEqual(1);

    const r = await gql(`mutation { autoUndo { result flightPlan { id } success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.autoUndo.result.removed).toBeGreaterThanOrEqual(1);
    expect(autoBlockCount()).toBe(0); // the run's blocks are gone
    expect(r.body.data.autoUndo.flightPlan.find((e: any) => e.id === t)).toBeDefined(); // re-staged
    expect(auditCount('undo')).toBe(1);
  });
});

describe('W13 — clearPlanner', () => {
  it('bad start → BAD_USER_INPUT', async () => {
    const r = await gql(`mutation { clearPlanner(input: { start: "nope" }) { mode success } }`);
    expect(r.body.data?.clearPlanner ?? null).toBeNull();
    expect(r.body.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('end < start → BAD_USER_INPUT', async () => {
    const r = await gql(`mutation { clearPlanner(input: { start: "2026-06-10", end: "2026-06-01" }) { mode } }`);
    expect(r.body.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('explicit dryRun: null → BAD_USER_INPUT (parity with REST rejecting dry_run: null; not silently an apply)', async () => {
    const r = await gql(`mutation { clearPlanner(input: { start: "2026-06-10", dryRun: null }) { mode } }`);
    expect(r.body.data?.clearPlanner ?? null).toBeNull();
    expect(r.body.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(r.body.errors?.[0].message).toMatch(/dryRun/); // GraphQL field name, not snake_case dry_run
  });

  // A daily recurring block template + a materialized window (T0..T4). Instances only
  // materialize within a horizon relative to *now*, so anchor at today (T0).
  const makeDaily = async () =>
    (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Deep Work', block_kind: 'timeblock', block_type: 'scheduled', start_at: `${T0}T09:00:00.000Z`, end_at: `${T0}T11:00:00.000Z`, recurrence_rule: 'FREQ=DAILY' },
    })).body.block;
  const materialize = () => api(srv.url, `/api/blocks?from=${T0}T00:00:00.000Z&to=${T4}T23:59:00.000Z`);

  it('dry-run reports counts and writes nothing (no snapshot)', async () => {
    const tpl = await makeDaily();
    await materialize();
    const before = (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks`).get() as { n: number }).n;

    const r = await gql(`mutation { clearPlanner(input: { start: "${T2}", dryRun: true }) { mode blocksDeleted generators backup success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.clearPlanner.mode).toBe('open-ended');
    expect(r.body.data.clearPlanner.blocksDeleted).toBe(3); // T2, T3, T4
    expect(r.body.data.clearPlanner.backup).toBeNull(); // no snapshot on dry-run
    expect(Array.isArray(r.body.data.clearPlanner.generators)).toBe(true);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks`).get() as { n: number }).n).toBe(before); // nothing written
    expect((sqlite.prepare(`SELECT recurrence_rule FROM time_blocks WHERE id = ?`).get(tpl.id) as { recurrence_rule: string }).recurrence_rule).toBe('FREQ=DAILY'); // rule intact
    expect(auditCount('clear-range')).toBe(0); // no audit on dry-run
  });

  it('apply deletes on/after start and caps the rule (REST cross-check)', async () => {
    const tpl = await makeDaily();
    await materialize();

    const r = await gql(`mutation { clearPlanner(input: { start: "${T2}" }) { mode blocksDeleted backup success } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.clearPlanner.blocksDeleted).toBe(3); // T2, T3, T4
    expect(r.body.data.clearPlanner.backup).toMatch(/companion-preclear-.*\.db$/);
    expect((sqlite.prepare(`SELECT recurrence_rule FROM time_blocks WHERE id = ?`).get(tpl.id) as { recurrence_rule: string }).recurrence_rule).toContain('UNTIL=');
    expect(auditCount('clear-range')).toBe(1);

    // REST cross-check: no instance re-materializes on/after the cutoff.
    const blocks = (await materialize()).body.blocks as any[];
    const onOrAfterCut = blocks.filter((b) => b.recurrence_parent_id === tpl.id && b.occurrence_date >= T2);
    expect(onOrAfterCut).toHaveLength(0);
  });
});

describe('W13 — cross-owner isolation', () => {
  beforeEach(() => { createOwner(OTHER); });

  it('autoRun as owner B never touches owner A staged plan', async () => {
    const aTask = insertTask('A task', OWNER);
    stageTask(aTask, OWNER);
    const bTask = insertTask('B task', OTHER);
    stageTask(bTask, OTHER);

    // Run auto as owner B (bind via x-test-owner).
    const r = await gql(`mutation { autoRun(input: { date: "${DATE}" }) { result flightPlan { id } success } }`, { 'x-test-owner': OTHER });
    expect(r.body.errors).toBeUndefined();

    // Owner A's flight plan is untouched: their task is still staged, no A blocks created.
    expect(fpCount(OWNER)).toBe(1);
    const fpA = (sqlite.prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ?`).all(OWNER) as { task_id: string }[]).map((x) => x.task_id);
    expect(fpA).toContain(aTask);
    expect(autoBlockCount(OWNER)).toBe(0); // owner A got no blocks
    // Owner B's task did get placed (drained from B's plan).
    expect(fpCount(OTHER)).toBe(0);
    expect(autoBlockCount(OTHER)).toBeGreaterThanOrEqual(1);
    // The GraphQL flightPlan returned to B contains only B's (now-empty) plan, never A's.
    expect(r.body.data.autoRun.flightPlan.find((e: any) => e.id === aTask)).toBeUndefined();
  });

  it('clearPlanner as owner B never clears owner A blocks', async () => {
    // Owner A has a plain block in range (T2).
    sqlite.prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_auto, source_kind, status)
       VALUES (uuid7(), ?, 'A block', 'task', ?, ?, 1, 'agent', 'planned')`,
    ).run(OWNER, `${T2}T09:00:00.000Z`, `${T2}T10:00:00.000Z`);
    const aBefore = (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE owner_id = ?`).get(OWNER) as { n: number }).n;

    const r = await gql(`mutation { clearPlanner(input: { start: "${T0}" }) { blocksDeleted success } }`, { 'x-test-owner': OTHER });
    expect(r.body.errors).toBeUndefined();
    // Owner A's block is untouched (owner B's clear is owner-scoped).
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE owner_id = ?`).get(OWNER) as { n: number }).n).toBe(aBefore);
  });
});
