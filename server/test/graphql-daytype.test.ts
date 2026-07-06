import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W7 — DayTypeType + TagPrefType end-to-end over HTTP. Proves the
 * dayTypes/dayType/resolveDayType queries, the day-type catalog CRUD + guards, the
 * category tagPrefs query + setTagPref mutation (reusing the SAME services the REST routes
 * use, cross-checked via REST GET), the category field resolver, validation error mapping,
 * and cross-owner isolation.
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

const makeCategory = (name: string, owner = OWNER): string =>
  (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`).get(owner, name) as { id: string }).id;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM day_types WHERE is_builtin = 0; DELETE FROM day_assignments; DELETE FROM day_of_week_map; DELETE FROM tag_prefs;`);
});

describe('W7 — DayTypeType', () => {
  it('dayTypes lists the built-ins; dayType(id) fetches one', async () => {
    const r = await gql('{ dayTypes { id key name isBuiltin } }');
    expect(r.body.errors).toBeUndefined();
    const keys = r.body.data.dayTypes.map((d: any) => d.key);
    expect(keys).toContain('workday');
    expect(keys).toContain('weekend');
    const workday = r.body.data.dayTypes.find((d: any) => d.key === 'workday');
    expect(workday.isBuiltin).toBe(true);

    const one = await gql(`{ dayType(id: "${workday.id}") { key isBuiltin } }`);
    expect(one.body.data.dayType).toEqual({ key: 'workday', isBuiltin: true });
  });

  it('createDayType creates a custom type, visible via REST GET; guards dup + bad key', async () => {
    const m = await gql('mutation { createDayType(input: { key: "travel", name: "Travel day" }) { success dayType { key name isBuiltin } } }');
    expect(m.body.data.createDayType).toEqual({ success: true, dayType: { key: 'travel', name: 'Travel day', isBuiltin: false } });
    const rest = await api(srv.url, '/api/day-types');
    expect((rest.body as { day_types: { key: string }[] }).day_types.some((d) => d.key === 'travel')).toBe(true);

    const dup = await gql('mutation { createDayType(input: { key: "travel", name: "Again" }) { success } }');
    expect(dup.body.errors?.[0]?.message).toMatch(/already exists/i);
    const badKey = await gql('mutation { createDayType(input: { key: "Not A Slug", name: "x" }) { success } }');
    expect(badKey.body.errors?.[0]?.message).toMatch(/lowercase slug/i);
  });

  it('renameDayType renames; deleteDayType removes a custom type but refuses a built-in', async () => {
    const id = (await gql('mutation { createDayType(input: { key: "focusday", name: "Old" }) { dayType { id } } }')).body.data.createDayType.dayType.id;
    const u = await gql(`mutation { renameDayType(input: { id: "${id}", name: "Focus" }) { dayType { name } } }`);
    expect(u.body.data.renameDayType.dayType.name).toBe('Focus');
    const d = await gql(`mutation { deleteDayType(input: { id: "${id}" }) { success deletedId } }`);
    expect(d.body.data.deleteDayType).toEqual({ success: true, deletedId: id });

    const workdayId = (await gql('{ dayTypes { id key } }')).body.data.dayTypes.find((x: any) => x.key === 'workday').id;
    const builtin = await gql(`mutation { deleteDayType(input: { id: "${workdayId}" }) { success } }`);
    expect(builtin.body.errors?.[0]?.message).toMatch(/built-in/i);
  });

  it('resolveDayType reports the key + source; an assignment overrides the default', async () => {
    const plain = await gql('{ resolveDayType(date: "2026-07-06") { date key source } }');
    expect(plain.body.data.resolveDayType.date).toBe('2026-07-06');
    expect(plain.body.data.resolveDayType.source).toBe('default');
    expect(['workday', 'weekend']).toContain(plain.body.data.resolveDayType.key);

    // Assign the date via REST (assignment writes are deferred from GraphQL) → source flips.
    await api(srv.url, '/api/day-types/assignments/2026-07-06', { method: 'PUT', json: { day_type_key: 'weekend' } });
    const assigned = await gql('{ resolveDayType(date: "2026-07-06") { key source } }');
    expect(assigned.body.data.resolveDayType).toEqual({ key: 'weekend', source: 'assignment' });

    const bad = await gql('{ resolveDayType(date: "2026-13-99") { key } }');
    expect(bad.body.errors?.[0]?.message).toMatch(/YYYY-MM-DD/i);
  });
});

describe('W7 — TagPrefType (category axis)', () => {
  it('setTagPref upserts, visible via query + REST GET; category resolves', async () => {
    const cat = makeCategory('Family');
    const m = await gql(`mutation { setTagPref(input: { categoryTagId: "${cat}", colorToken: "chart-2", defaultMinutes: 30 }) { success tagPref { colorToken defaultMinutes category { id label } } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.setTagPref.tagPref).toEqual({ colorToken: 'chart-2', defaultMinutes: 30, category: { id: cat, label: 'Family' } });

    const q = await gql('{ tagPrefs { category { id } colorToken defaultMinutes } }');
    expect(q.body.data.tagPrefs).toEqual([{ category: { id: cat }, colorToken: 'chart-2', defaultMinutes: 30 }]);

    const rest = await api(srv.url, '/api/category-prefs');
    expect(rest.body.prefs[cat]).toMatchObject({ color_token: 'chart-2', default_minutes: 30 });
  });

  it('validation: non-category tag, non-positive default', async () => {
    const dir = (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, 'work', 'direction') RETURNING id`).get(OWNER) as { id: string }).id;
    expect((await gql(`mutation { setTagPref(input: { categoryTagId: "${dir}", colorToken: "x" }) { success } }`)).body.errors?.[0]?.message).toMatch(/not a category/i);

    const cat = makeCategory('Home');
    expect((await gql(`mutation { setTagPref(input: { categoryTagId: "${cat}", defaultMinutes: 0 }) { success } }`)).body.errors?.[0]?.message).toMatch(/defaultMinutes/i);
  });
});

describe('W7 — owner scoping', () => {
  it('another owner cannot rename/delete this owner\'s day type or set its category pref', async () => {
    createOwner(OTHER);
    const id = (await gql('mutation { createDayType(input: { key: "mine", name: "Mine" }) { dayType { id } } }')).body.data.createDayType.dayType.id;
    const cat = makeCategory('MineCat', OWNER);

    // Cross-owner day-type mutations resolve as not-found (the get is owner-scoped).
    expect((await gql(`mutation { renameDayType(input: { id: "${id}", name: "Hax" }) { success } }`, { 'x-test-owner': OTHER })).body.errors?.[0]?.message).toMatch(/not found/i);
    expect((await gql(`mutation { deleteDayType(input: { id: "${id}" }) { success } }`, { 'x-test-owner': OTHER })).body.errors?.[0]?.message).toMatch(/not found/i);
    // Cross-owner category tag → Tag not found for B.
    expect((await gql(`mutation { setTagPref(input: { categoryTagId: "${cat}", colorToken: "x" }) { success } }`, { 'x-test-owner': OTHER })).body.errors?.[0]?.message).toMatch(/tag not found/i);

    // A's day type survives; B sees only its own catalog (no 'mine').
    expect((await gql('{ dayTypes { key } }')).body.data.dayTypes.some((d: any) => d.key === 'mine')).toBe(true);
    expect((await gql('{ dayTypes { key } }', { 'x-test-owner': OTHER })).body.data.dayTypes.some((d: any) => d.key === 'mine')).toBe(false);
  });
});
