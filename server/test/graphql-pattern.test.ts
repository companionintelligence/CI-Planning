import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W6 — PatternType + PatternKindType end-to-end over HTTP. Proves the
 * patternKinds/patternKind + patterns/pattern queries, the field resolvers (kind, tasks),
 * the CRUD mutations reusing the SAME services the REST routes use (cross-checked via REST
 * GET), the recurrence guard, the delete guards (built-in / in-use kinds), and cross-owner
 * isolation. Ships as Pattern / PatternKind types (the Z-W1 rename hasn't landed).
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

const insertTask = (title: string, owner = OWNER): string =>
  (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), ?, ?, 'open') RETURNING id`).get(title, owner) as { id: string }).id;
const kindId = (name: string, owner = OWNER): string =>
  (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = ? AND owner_id = ?`).get(name, owner) as { id: string }).id;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM pattern_tasks; DELETE FROM patterns; DELETE FROM pattern_types WHERE is_builtin = 0;`);
});

describe('W6 — PatternKindType', () => {
  it('patternKinds lists the built-ins (Ritual hidden by default)', async () => {
    const r = await gql('{ patternKinds { name iconShape isBuiltin } }');
    expect(r.body.errors).toBeUndefined();
    const names = r.body.data.patternKinds.map((k: any) => k.name).sort();
    expect(names).toEqual(['Community', 'Habit', 'Routine']);
    const habit = r.body.data.patternKinds.find((k: any) => k.name === 'Habit');
    expect(habit).toMatchObject({ iconShape: 'circle', isBuiltin: true });
  });

  it('createPatternKind is visible via REST GET (shared service)', async () => {
    const m = await gql('mutation { createPatternKind(input: { name: "Errand-run", iconShape: "hexagon" }) { success patternKind { name iconShape isBuiltin } } }');
    expect(m.body.data.createPatternKind).toMatchObject({ success: true, patternKind: { name: 'Errand-run', iconShape: 'hexagon', isBuiltin: false } });
    const rest = await api(srv.url, '/api/pattern-types');
    expect((rest.body as { pattern_types: { name: string }[] }).pattern_types.some((t) => t.name === 'Errand-run')).toBe(true);
  });

  it('updatePatternKind renames', async () => {
    const id = (await gql('mutation { createPatternKind(input: { name: "Temp", iconShape: "square" }) { patternKind { id } } }')).body.data.createPatternKind.patternKind.id;
    const m = await gql(`mutation { updatePatternKind(input: { id: "${id}", name: "Renamed" }) { patternKind { name } } }`);
    expect(m.body.data.updatePatternKind.patternKind.name).toBe('Renamed');
  });

  it('deletePatternKind removes a custom kind; refuses a built-in and an in-use kind', async () => {
    const id = (await gql('mutation { createPatternKind(input: { name: "Zap", iconShape: "square" }) { patternKind { id } } }')).body.data.createPatternKind.patternKind.id;
    expect((await gql(`mutation { deletePatternKind(input: { id: "${id}" }) { success deletedId } }`)).body.data.deletePatternKind).toEqual({ success: true, deletedId: id });

    const builtin = await gql(`mutation { deletePatternKind(input: { id: "${kindId('Habit')}" }) { success } }`);
    expect(builtin.body.errors?.[0]?.message).toMatch(/built-in/i);

    const custom = (await gql('mutation { createPatternKind(input: { name: "Busy", iconShape: "square" }) { patternKind { id } } }')).body.data.createPatternKind.patternKind.id;
    await gql(`mutation { createPattern(input: { name: "Uses it", kindId: "${custom}" }) { success } }`);
    const inUse = await gql(`mutation { deletePatternKind(input: { id: "${custom}" }) { success } }`);
    expect(inUse.body.errors?.[0]?.message).toMatch(/in use/i);
  });
});

describe('W6 — PatternType', () => {
  it('createPattern with a kind + member tasks; pattern(id) resolves kind + tasks', async () => {
    const a = insertTask('Stretch');
    const b = insertTask('Meditate');
    const m = await gql(`mutation { createPattern(input: { name: "Morning", kindId: "${kindId('Routine')}", tag: "am", taskIds: ["${a}", "${b}"] }) { success pattern { id name tag } } }`);
    expect(m.body.data.createPattern.success).toBe(true);
    const id = m.body.data.createPattern.pattern.id;
    expect(m.body.data.createPattern.pattern).toMatchObject({ name: 'Morning', tag: 'am' });

    const r = await gql(`{ pattern(id: "${id}") { name kind { name } tasks { id title } } }`);
    expect(r.body.data.pattern.kind.name).toBe('Routine');
    expect(r.body.data.pattern.tasks.map((t: any) => t.title).sort()).toEqual(['Meditate', 'Stretch']);
    // REST sees the same pattern.
    expect((await api(srv.url, `/api/patterns/${id}`)).body.pattern.name).toBe('Morning');
  });

  it('patterns lists the owner\'s patterns', async () => {
    await gql(`mutation { createPattern(input: { name: "P1", kindId: "${kindId('Routine')}" }) { success } }`);
    await gql(`mutation { createPattern(input: { name: "P2", kindId: "${kindId('Routine')}" }) { success } }`);
    const r = await gql('{ patterns { name } }');
    expect(r.body.data.patterns.map((p: any) => p.name).sort()).toEqual(['P1', 'P2']);
  });

  it('updatePattern renames + retags; deletePattern removes', async () => {
    const id = (await gql(`mutation { createPattern(input: { name: "Old", kindId: "${kindId('Routine')}" }) { pattern { id } } }`)).body.data.createPattern.pattern.id;
    const u = await gql(`mutation { updatePattern(input: { id: "${id}", name: "New", tag: "x" }) { pattern { name tag } } }`);
    expect(u.body.data.updatePattern.pattern).toEqual({ name: 'New', tag: 'x' });
    const d = await gql(`mutation { deletePattern(input: { id: "${id}" }) { success deletedId } }`);
    expect(d.body.data.deletePattern).toEqual({ success: true, deletedId: id });
    expect((await gql(`{ pattern(id: "${id}") { id } }`)).body.data.pattern).toBeNull();
  });

  it('addPatternTask / removePatternTask edit membership', async () => {
    const id = (await gql(`mutation { createPattern(input: { name: "Members", kindId: "${kindId('Routine')}" }) { pattern { id } } }`)).body.data.createPattern.pattern.id;
    const t = insertTask('Do it');
    const add = await gql(`mutation { addPatternTask(input: { patternId: "${id}", taskId: "${t}" }) { pattern { tasks { id } } } }`);
    expect(add.body.data.addPatternTask.pattern.tasks.map((x: any) => x.id)).toEqual([t]);
    const rem = await gql(`mutation { removePatternTask(input: { patternId: "${id}", taskId: "${t}" }) { pattern { tasks { id } } } }`);
    expect(rem.body.data.removePatternTask.pattern.tasks).toEqual([]);
  });

  it('recurrence: allowed on Routine, rejected on a non-Habit/Routine kind', async () => {
    const ok = await gql(`mutation { createPattern(input: { name: "Daily", kindId: "${kindId('Routine')}", recurrenceRule: "FREQ=DAILY" }) { success pattern { recurrenceRule recurrenceDtstart } } }`);
    expect(ok.body.data.createPattern.success).toBe(true);
    expect(ok.body.data.createPattern.pattern.recurrenceRule).toMatch(/FREQ=DAILY/);
    expect(ok.body.data.createPattern.pattern.recurrenceDtstart).toBeTruthy(); // defaulted to local-noon-as-UTC

    const bad = await gql(`mutation { createPattern(input: { name: "Nope", kindId: "${kindId('Community')}", recurrenceRule: "FREQ=DAILY" }) { success } }`);
    expect(bad.body.errors?.[0]?.message).toMatch(/only Habit and Routine/i);
  });

  it('createPattern rejects a blank name and an unknown kind', async () => {
    expect((await gql('mutation { createPattern(input: { name: "  " }) { success } }')).body.errors?.[0]?.message).toMatch(/name is required/i);
    expect((await gql('mutation { createPattern(input: { name: "X", kindId: "nope" }) { success } }')).body.errors?.[0]?.message).toMatch(/unknown pattern kind/i);
  });
});

describe('W6 — owner scoping', () => {
  it('another owner cannot see or mutate this owner\'s pattern/kind', async () => {
    createOwner(OTHER);
    const id = (await gql(`mutation { createPattern(input: { name: "Mine", kindId: "${kindId('Routine')}" }) { pattern { id } } }`)).body.data.createPattern.pattern.id;

    // Owner B sees none of A's patterns, and A's id resolves null + is unmutatable for B.
    expect((await gql('{ patterns { id } }', { 'x-test-owner': OTHER })).body.data.patterns).toEqual([]);
    expect((await gql(`{ pattern(id: "${id}") { id } }`, { 'x-test-owner': OTHER })).body.data.pattern).toBeNull();
    const del = await gql(`mutation { deletePattern(input: { id: "${id}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(del.body.errors?.[0]?.message).toMatch(/not found/i);

    // A's pattern survives.
    expect((await gql(`{ pattern(id: "${id}") { name } }`)).body.data.pattern.name).toBe('Mine');
  });
});
