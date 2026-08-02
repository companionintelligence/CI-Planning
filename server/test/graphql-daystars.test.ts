import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { freezeStars } from '../src/jobs/freeze-stars.js';

/**
 * Phase W · W8c — DayStarsType + DailyRecapType end-to-end over HTTP. Proves the
 * dayStars(from,to) range query (live compute + frozen-snapshot precedence), the
 * dailyRecap(date) single-row read (summary group + star group, JSON blobs, null when
 * absent), field mapping (id = the date, natural-key-as-Node-id), and cross-owner
 * isolation. Reuses the SAME services GET /api/stars uses, cross-checked via REST GET.
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

const DAY = '2026-06-15';        // Monday
const NEXT_DAY = '2026-06-16';
const FREEZE_NOW = '2026-06-17T00:20:00.000Z';

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  return { status: res.status, body };
}

/** Seed a done today_goal (lights S1 objective). */
function setDoneGoal(date = DAY, owner = OWNER) {
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO reflections (owner_id, kind, period_key, position, body, done_at, created_at, updated_at)
     VALUES (?, 'today_goal', ?, 0, 'Goal', ?, ?, ?)`,
  ).run(owner, date, now, now, now);
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM daily_recap; DELETE FROM reflections; DELETE FROM daily_plan;`);
});

describe('W8c — DayStarsType (dayStars range query)', () => {
  it('computes live for days with no frozen row; id is the date; matches REST', async () => {
    setDoneGoal(DAY);
    const r = await gql(`{ dayStars(from: "${DAY}", to: "${DAY}") { id date objective habits tasks bonus note total frozen } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.dayStars).toEqual([
      { id: DAY, date: DAY, objective: true, habits: false, tasks: false, bonus: false, note: false, total: 1, frozen: false },
    ]);

    // Cross-check the shared service against REST GET /api/stars.
    const rest = await api(srv.url, `/api/stars?from=${DAY}&to=${DAY}`);
    expect(rest.body[0]).toMatchObject({ date: DAY, objective: true, total: 1, frozen: false });
  });

  it('returns one entry per date across the range (bounded list, not a connection)', async () => {
    const r = await gql(`{ dayStars(from: "${DAY}", to: "${NEXT_DAY}") { date frozen } }`);
    expect(r.body.data.dayStars.map((d: any) => d.date)).toEqual([DAY, NEXT_DAY]);
    expect(r.body.data.dayStars.every((d: any) => d.frozen === false)).toBe(true);
  });

  it('prefers the FROZEN snapshot over a live recompute', async () => {
    // Freeze DAY at total 1, then change the live world so a recompute would give 2.
    setDoneGoal(DAY);
    await runWithOwner(OWNER, ALL_SCOPES, () => freezeStars(DAY, FREEZE_NOW));
    sqlite.prepare(
      `INSERT INTO tasks (id, title, status, completed_at, owner_id)
       VALUES (uuid7(), 'Late win', 'done', ?, ?)`,
    ).run(`${DAY}T12:00:00.000Z`, OWNER);

    const r = await gql(`{ dayStars(from: "${DAY}", to: "${DAY}") { total frozen } }`);
    expect(r.body.data.dayStars[0]).toEqual({ total: 1, frozen: true });
  });

  it('rejects a malformed date', async () => {
    const r = await gql('{ dayStars(from: "2026-13-99", to: "2026-13-99") { total } }');
    expect(r.body.errors?.[0]?.message).toMatch(/YYYY-MM-DD/i);
  });
});

describe('W8c — DailyRecapType (dailyRecap single-row read)', () => {
  it('returns null when no row has been written for the date', async () => {
    const r = await gql(`{ dailyRecap(date: "${DAY}") { id } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.dailyRecap).toBeNull();
  });

  it('reads the summary group with JSON blobs; star group is null until frozen', async () => {
    sqlite.prepare(
      `INSERT INTO daily_recap (owner_id, date, prose, stats, focus, llm, inputs_hash)
       VALUES (?, ?, 'Morning brief', '{"tasks":3}', '[{"taskId":"t1"}]', 1, 'hash-1')`,
    ).run(OWNER, DAY);

    const r = await gql(`{ dailyRecap(date: "${DAY}") { id date prose stats focus llm inputsHash objective total frozenAt } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.dailyRecap).toEqual({
      id: DAY,
      date: DAY,
      prose: 'Morning brief',
      stats: { tasks: 3 },       // JSON scalar → real object, not a doubly-encoded string
      focus: [{ taskId: 't1' }],
      llm: true,
      inputsHash: 'hash-1',
      objective: null,           // star group not frozen yet
      total: null,
      frozenAt: null,
    });
  });

  it('reads the frozen star group (frozenAt set) after the freeze job runs', async () => {
    setDoneGoal(DAY);
    await runWithOwner(OWNER, ALL_SCOPES, () => freezeStars(DAY, FREEZE_NOW));

    const r = await gql(`{ dailyRecap(date: "${DAY}") { objective habits tasks bonus note total frozenAt } }`);
    const recap = r.body.data.dailyRecap;
    expect(recap).toMatchObject({ objective: true, habits: false, tasks: false, bonus: false, note: false, total: 1 });
    expect(recap.frozenAt).toBe('2026-06-17T00:20:00.000Z');
  });

  it('rejects a malformed date', async () => {
    const r = await gql('{ dailyRecap(date: "not-a-date") { id } }');
    expect(r.body.errors?.[0]?.message).toMatch(/YYYY-MM-DD/i);
  });
});

describe('W8c — owner scoping', () => {
  it('each owner sees only its own stars and recap rows', async () => {
    createOwner(OTHER);
    // Owner A: a done goal on DAY. Owner B: nothing.
    setDoneGoal(DAY, OWNER);
    sqlite.prepare(
      `INSERT INTO daily_recap (owner_id, date, prose, stats, focus, llm, inputs_hash)
       VALUES (?, ?, 'A only', '{}', '[]', 0, 'h')`,
    ).run(OWNER, DAY);

    // A sees its star + recap.
    const aStars = await gql(`{ dayStars(from: "${DAY}", to: "${DAY}") { total } }`);
    expect(aStars.body.data.dayStars[0].total).toBe(1);
    const aRecap = await gql(`{ dailyRecap(date: "${DAY}") { prose } }`);
    expect(aRecap.body.data.dailyRecap.prose).toBe('A only');

    // B (via x-test-owner) sees a zeroed live day and NO recap row (isolation).
    const bStars = await gql(`{ dayStars(from: "${DAY}", to: "${DAY}") { total frozen } }`, { 'x-test-owner': OTHER });
    expect(bStars.body.data.dayStars[0]).toEqual({ total: 0, frozen: false });
    const bRecap = await gql(`{ dailyRecap(date: "${DAY}") { prose } }`, { 'x-test-owner': OTHER });
    expect(bRecap.body.data.dailyRecap).toBeNull();
  });
});
