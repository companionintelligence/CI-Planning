import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W6b — PatternBlockType + PatternPrefType end-to-end over HTTP. Proves the
 * patternBlocks(dayType)/patternPrefs queries, the direction field resolver, the
 * set-ranges + set-pref mutations reusing the SAME services (+ extracted validation
 * wrappers) the REST routes use (cross-checked via REST GET), the validation error
 * mapping, and cross-owner isolation.
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

const makeTag = (name: string, kind: 'direction' | 'intention', owner = OWNER): string =>
  (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, ?) RETURNING id`).get(owner, name, kind) as { id: string }).id;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM pattern_blocks; DELETE FROM tag_prefs;`);
});

describe('W6b — PatternBlockType', () => {
  it('setPatternBlockRanges creates windows, visible via query + REST GET; direction resolves', async () => {
    const work = makeTag('work', 'direction');
    const m = await gql(`mutation { setPatternBlockRanges(input: { directionTagId: "${work}", dayType: "workday", ranges: [{ startTime: "09:00", endTime: "12:00" }, { startTime: "13:00", endTime: "17:00" }] }) { success patternBlocks { dayType startTime endTime direction { id label } } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.setPatternBlockRanges.success).toBe(true);
    const blocks = m.body.data.setPatternBlockRanges.patternBlocks;
    expect(blocks.map((b: any) => [b.startTime, b.endTime])).toEqual([['09:00', '12:00'], ['13:00', '17:00']]);
    expect(blocks[0].direction).toEqual({ id: work, label: 'work' });

    const q = await gql(`{ patternBlocks(dayType: "workday") { startTime endTime direction { label } } }`);
    expect(q.body.data.patternBlocks).toHaveLength(2);
    expect(q.body.data.patternBlocks[0].direction.label).toBe('work');

    // A second direction's windows interleave deterministically (sorted by direction id,
    // then start) — not left to object-key order.
    const life = makeTag('life', 'direction');
    await gql(`mutation { setPatternBlockRanges(input: { directionTagId: "${life}", dayType: "workday", ranges: [{ startTime: "07:00", endTime: "08:00" }] }) { success } }`);
    const q2 = await gql(`{ patternBlocks(dayType: "workday") { startTime direction { id } } }`);
    const expected = [...q2.body.data.patternBlocks].sort(
      (a: any, b: any) => a.direction.id.localeCompare(b.direction.id) || a.startTime.localeCompare(b.startTime),
    );
    expect(q2.body.data.patternBlocks).toEqual(expected); // already in that order
    expect(q2.body.data.patternBlocks).toHaveLength(3);

    // REST sees the same windows (one store).
    const rest = await api(srv.url, '/api/pattern-blocks');
    expect(rest.body.workday[work].map((r: any) => [r.start_time, r.end_time])).toEqual([['09:00', '12:00'], ['13:00', '17:00']]);
  });

  it('validation: non-direction tag, invalid day type, bad ranges', async () => {
    const intent = makeTag('coding', 'intention');
    const notDir = await gql(`mutation { setPatternBlockRanges(input: { directionTagId: "${intent}", dayType: "workday", ranges: [] }) { success } }`);
    expect(notDir.body.errors?.[0]?.message).toMatch(/not a direction/i);

    const work = makeTag('work', 'direction');
    const badDay = await gql(`mutation { setPatternBlockRanges(input: { directionTagId: "${work}", dayType: "nope", ranges: [] }) { success } }`);
    expect(badDay.body.errors?.[0]?.message).toMatch(/invalid day_type/i);

    const badRange = await gql(`mutation { setPatternBlockRanges(input: { directionTagId: "${work}", dayType: "workday", ranges: [{ startTime: "17:00", endTime: "09:00" }] }) { success } }`);
    expect(badRange.body.errors?.[0]?.message).toMatch(/before end_time/i);

    const unknownTag = await gql('mutation { setPatternBlockRanges(input: { directionTagId: "nope", dayType: "workday", ranges: [] }) { success } }');
    expect(unknownTag.body.errors?.[0]?.message).toMatch(/tag not found/i);
  });
});

describe('W6b — PatternPrefType', () => {
  it('setPatternPref upserts, visible via query + REST GET; direction resolves', async () => {
    const work = makeTag('work', 'direction');
    const m = await gql(`mutation { setPatternPref(input: { directionTagId: "${work}", autoFill: false, reminderOffsets: [10, 30], iconShape: "square", colorToken: "chart-1", defaultMinutes: 45 }) { success patternPref { autoFill reminderOffsets iconShape colorToken defaultMinutes direction { id label } } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.setPatternPref.patternPref).toEqual({
      autoFill: false, reminderOffsets: [10, 30], iconShape: 'square', colorToken: 'chart-1', defaultMinutes: 45,
      direction: { id: work, label: 'work' },
    });

    const q = await gql('{ patternPrefs { direction { id } autoFill defaultMinutes } }');
    expect(q.body.data.patternPrefs).toEqual([{ direction: { id: work }, autoFill: false, defaultMinutes: 45 }]);

    // REST sees it.
    const rest = await api(srv.url, '/api/pattern-prefs');
    expect(rest.body.prefs[work]).toMatchObject({ auto_fill: false, reminder_offsets: [10, 30], icon_shape: 'square', default_minutes: 45 });
  });

  it('merge-on-write preserves untouched fields', async () => {
    const work = makeTag('work', 'direction');
    await gql(`mutation { setPatternPref(input: { directionTagId: "${work}", defaultMinutes: 90 }) { success } }`);
    const m = await gql(`mutation { setPatternPref(input: { directionTagId: "${work}", autoFill: false }) { patternPref { autoFill defaultMinutes } } }`);
    expect(m.body.data.setPatternPref.patternPref).toMatchObject({ autoFill: false, defaultMinutes: 90 });
  });

  it('validation: non-direction tag, bad icon shape, non-positive default', async () => {
    const intent = makeTag('coding', 'intention');
    expect((await gql(`mutation { setPatternPref(input: { directionTagId: "${intent}", autoFill: true }) { success } }`)).body.errors?.[0]?.message).toMatch(/not a direction/i);

    const work = makeTag('work', 'direction');
    expect((await gql(`mutation { setPatternPref(input: { directionTagId: "${work}", iconShape: "hexagon" }) { success } }`)).body.errors?.[0]?.message).toMatch(/iconShape/i);
    expect((await gql(`mutation { setPatternPref(input: { directionTagId: "${work}", defaultMinutes: 0 }) { success } }`)).body.errors?.[0]?.message).toMatch(/defaultMinutes/i);
  });
});

describe('W6b — owner scoping', () => {
  it('another owner cannot set ranges/pref on this owner\'s direction tag', async () => {
    createOwner(OTHER);
    const work = makeTag('work', 'direction', OWNER);
    const ranges = await gql(`mutation { setPatternBlockRanges(input: { directionTagId: "${work}", dayType: "workday", ranges: [{ startTime: "09:00", endTime: "10:00" }] }) { success } }`, { 'x-test-owner': OTHER });
    expect(ranges.body.errors?.[0]?.message).toMatch(/tag not found/i);
    const pref = await gql(`mutation { setPatternPref(input: { directionTagId: "${work}", autoFill: false }) { success } }`, { 'x-test-owner': OTHER });
    expect(pref.body.errors?.[0]?.message).toMatch(/tag not found/i);

    // Owner B sees no windows/prefs for that day either.
    expect((await gql('{ patternBlocks(dayType: "workday") { id } }', { 'x-test-owner': OTHER })).body.data.patternBlocks).toEqual([]);
    expect((await gql('{ patternPrefs { autoFill } }', { 'x-test-owner': OTHER })).body.data.patternPrefs).toEqual([]);
  });
});
