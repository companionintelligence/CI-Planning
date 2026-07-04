import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W5 — FlightPlanEntryType end-to-end over HTTP. Proves the `flightPlan` query
 * + the staging mutations reuse the SAME services/flight-plan.ts the REST routes use
 * (cross-checked via REST GET), the `task` field resolver, error mapping (recurrence
 * instance, unknown ids, not-staged), SSE parity (a mutation fires flight_plan:*), and
 * cross-owner isolation.
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  return { status: res.status, body };
}

function insertTask(title: string, owner = OWNER, recurrenceRule?: string, recurrenceParentId?: string): string {
  return (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, priority, recurrence_rule, recurrence_parent_id)
       VALUES (uuid7(), ?, ?, 'open', 3, ?, ?) RETURNING id`,
    )
    .get(title, owner, recurrenceRule ?? null, recurrenceParentId ?? null) as { id: string }).id;
}
function makePattern(name: string, taskIds: string[], owner = OWNER): string {
  const ht = sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND owner_id = ?`).get(owner) as { id: string };
  const pid = (sqlite.prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING id`).get(owner, ht.id, name) as { id: string }).id;
  taskIds.forEach((tid, i) => sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(pid, tid, i));
  return pid;
}
function syncEventCount(owner: string, event: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_events WHERE owner_id = ? AND event = ?`).get(owner, event) as { n: number }).n;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM pattern_tasks; DELETE FROM patterns;`);
});

describe('W5 — flightPlan query', () => {
  it('returns staged entries with the task resolved, ordered by position', async () => {
    const a = insertTask('Alpha');
    const b = insertTask('Beta');
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: a } });
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: b } });

    const r = await gql('{ flightPlan { id selected position sourceKind task { id title } } }');
    expect(r.body.errors).toBeUndefined();
    const fp = r.body.data.flightPlan;
    expect(fp).toHaveLength(2);
    expect(fp.map((e: any) => e.id)).toEqual([a, b]);           // id === task_id, position order
    expect(fp[0]).toMatchObject({ selected: true, position: 0, sourceKind: 'manual' });
    expect(fp[0].task).toEqual({ id: a, title: 'Alpha' });
  });

  it('is empty when nothing is staged', async () => {
    const r = await gql('{ flightPlan { id } }');
    expect(r.body.data.flightPlan).toEqual([]);
  });
});

describe('W5 — mutations reuse the REST services', () => {
  it('stageFlightPlanTask stages a task, visible via REST GET (shared service) + fires SSE', async () => {
    const t = insertTask('Write report');
    const before = syncEventCount(OWNER, 'flight_plan:updated');
    const m = await gql(`mutation { stageFlightPlanTask(input: { taskId: "${t}" }) { success added flightPlan { id sourceKind } } }`);
    expect(m.body.data.stageFlightPlanTask).toMatchObject({ success: true, added: 1 });
    expect(m.body.data.stageFlightPlanTask.flightPlan[0]).toEqual({ id: t, sourceKind: 'manual' });
    // REST sees the same row (one store).
    const rest = await api(srv.url, '/api/flight-plan');
    expect(rest.body.flight_plan.map((x: any) => x.task_id)).toEqual([t]);
    expect(syncEventCount(OWNER, 'flight_plan:updated')).toBe(before + 1);
  });

  it('stageFlightPlanPattern stages the member tasks, tagged with the pattern', async () => {
    const a = insertTask('check ingredients');
    const b = insertTask('grocery shopping');
    const p = makePattern('Family dinner', [a, b]);
    const m = await gql(`mutation { stageFlightPlanPattern(input: { patternId: "${p}" }) { added flightPlan { id sourceKind } } }`);
    expect(m.body.data.stageFlightPlanPattern.added).toBe(2);
    expect(m.body.data.stageFlightPlanPattern.flightPlan.every((e: any) => e.sourceKind === 'pattern')).toBe(true);
    expect(m.body.data.stageFlightPlanPattern.flightPlan.map((e: any) => e.id).sort()).toEqual([a, b].sort());
  });

  it('updateFlightPlanEntry toggles selected and sets position', async () => {
    const t = insertTask('Task');
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: t } });
    const m = await gql(`mutation { updateFlightPlanEntry(input: { taskId: "${t}", selected: false, position: 5 }) { success flightPlan { selected position } } }`);
    expect(m.body.data.updateFlightPlanEntry.success).toBe(true);
    expect(m.body.data.updateFlightPlanEntry.flightPlan[0]).toMatchObject({ selected: false, position: 5 });
  });

  it('unstageFlightPlanEntry removes an entry (idempotent)', async () => {
    const t = insertTask('Task');
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: t } });
    const m = await gql(`mutation { unstageFlightPlanEntry(input: { taskId: "${t}" }) { success flightPlan { id } } }`);
    expect(m.body.data.unstageFlightPlanEntry).toEqual({ success: true, flightPlan: [] });
    // Unstaging again is a no-op, not an error.
    const again = await gql(`mutation { unstageFlightPlanEntry(input: { taskId: "${t}" }) { success } }`);
    expect(again.body.data.unstageFlightPlanEntry.success).toBe(true);
  });

  it('resetFlightPlan clears the whole plan', async () => {
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: insertTask('a') } });
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: insertTask('b') } });
    const before = syncEventCount(OWNER, 'flight_plan:reset');
    const m = await gql('mutation { resetFlightPlan { success cleared } }');
    expect(m.body.data.resetFlightPlan).toEqual({ success: true, cleared: 2 });
    expect((await gql('{ flightPlan { id } }')).body.data.flightPlan).toEqual([]);
    expect(syncEventCount(OWNER, 'flight_plan:reset')).toBe(before + 1);
  });
});

describe('W5 — error mapping', () => {
  it('stageFlightPlanTask rejects a recurrence instance', async () => {
    const template = insertTask('Daily standup', OWNER, 'FREQ=DAILY');
    const instance = insertTask('Daily standup', OWNER, undefined, template);
    const m = await gql(`mutation { stageFlightPlanTask(input: { taskId: "${instance}" }) { success } }`);
    expect(m.body.errors?.[0]?.message).toMatch(/template/i);
  });

  it('stageFlightPlanTask 404s an unknown task', async () => {
    const m = await gql('mutation { stageFlightPlanTask(input: { taskId: "nope" }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/task not found/i);
  });

  it('stageFlightPlanPattern 404s an unknown pattern', async () => {
    const m = await gql('mutation { stageFlightPlanPattern(input: { patternId: "nope" }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/pattern not found/i);
  });

  it('updateFlightPlanEntry 404s a non-staged task', async () => {
    const t = insertTask('unstaged');
    const m = await gql(`mutation { updateFlightPlanEntry(input: { taskId: "${t}", selected: false }) { success } }`);
    expect(m.body.errors?.[0]?.message).toMatch(/not staged/i);
  });
});

describe('W5 — owner scoping', () => {
  it('another owner cannot stage or see this owner\'s task', async () => {
    createOwner(OTHER);
    const mine = insertTask('Mine', OWNER);
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: mine } });

    // Owner B's flightPlan is empty and staging owner A's task id 404s (cross-owner invisible).
    const other = await gql('{ flightPlan { id } }', { 'x-test-owner': OTHER });
    expect(other.body.data.flightPlan).toEqual([]);
    const stageOther = await gql(`mutation { stageFlightPlanTask(input: { taskId: "${mine}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(stageOther.body.errors?.[0]?.message).toMatch(/task not found/i);

    // Owner A still sees their entry, untouched.
    expect((await gql('{ flightPlan { id } }')).body.data.flightPlan.map((e: any) => e.id)).toEqual([mine]);
  });

  it('a polluted flight_plan row pointing at another owner\'s task never leaks through the read', async () => {
    createOwner(OTHER);
    const theirs = insertTask('Theirs', OTHER);
    // Force owner A's plan to reference owner B's task (the defense-in-depth case: the
    // listFlightPlan JOIN pins t.owner_id = fp.owner_id, so this row is filtered out).
    sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, source_kind, selected, position) VALUES (?, ?, 'manual', 1, 0)`).run(OWNER, theirs);
    const r = await gql('{ flightPlan { id task { title } } }');
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.flightPlan).toEqual([]); // owner B's task is not exposed to A
  });

  it('staging a pattern skips cross-owner member tasks', async () => {
    createOwner(OTHER);
    const mine = insertTask('Mine', OWNER);
    const theirs = insertTask('Theirs', OTHER);
    // A pattern owned by A whose membership was polluted with owner B's task.
    const p = makePattern('Mixed', [mine], OWNER);
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 1)`).run(p, theirs);

    const m = await gql(`mutation { stageFlightPlanPattern(input: { patternId: "${p}" }) { added flightPlan { id } } }`);
    expect(m.body.data.stageFlightPlanPattern.added).toBe(1);                 // only the owner's member
    expect(m.body.data.stageFlightPlanPattern.flightPlan.map((e: any) => e.id)).toEqual([mine]);
  });
});
