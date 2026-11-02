import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * CON-4 — recurring Time Blocks. A template (recurrence_rule set, no parent) is
 * never rendered; GET materializes one instance per occurrence in the requested
 * range, via the SHARED rrule.js engine. Idempotent + concurrency-safe through the
 * partial unique index ux_block_occurrence. The 0025 pattern path is untouched.
 *
 * Dates are anchored to *today* (the lazy materializer skips past days), so the
 * suite never time-bombs.
 */

const OWNER = SYSTEM_OWNER;
const pad = (n: number) => String(n).padStart(2, '0');
function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const T0 = isoDay(0), T1 = isoDay(1), T2 = isoDay(2);
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;
const getBlocks = async (srv: TestServer, from: string, to: string) =>
  (await api(srv.url, `/api/blocks?from=${from}&to=${to}`)).body.blocks as any[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb(); // also pins timezone = 'UTC' (and all other scheduling_prefs) since PR #81
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
});
// Belt-and-suspenders: explicitly restore UTC after the non-UTC test below so a
// future refactor of resetDb() can't silently reintroduce the cross-file leak.
afterEach(() => {
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
});

async function makeRecurring(rule: string, tz = 'UTC', secondary: string[] = []) {
  if (tz !== 'UTC') sqlite.prepare(`UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?`).run(tz, OWNER);
  return (await api(srv.url, '/api/blocks', {
    method: 'POST',
    json: {
      title: 'Deep Work', block_kind: 'timeblock', block_type: 'scheduled', tag: 'focus',
      secondary_tags: secondary, start_at: at(T0, '09:00'), end_at: at(T0, '11:00'), recurrence_rule: rule,
    },
  })).body.block;
}

describe('CON-4 recurring Time Blocks', () => {
  it('materializes one instance per day, excludes the template, and is idempotent', async () => {
    const tpl = await makeRecurring('FREQ=DAILY');
    const first = await getBlocks(srv, at(T0, '00:00'), at(T2, '23:59'));
    const insts = first.filter((b) => b.recurrence_parent_id === tpl.id);
    expect(insts).toHaveLength(3);                                   // T0, T1, T2
    expect(first.some((b) => b.id === tpl.id)).toBe(false);          // template never rendered
    expect(insts.every((b) => b.start_at.endsWith('T09:00:00.000Z'))).toBe(true); // same wall time
    expect(insts.every((b) => b.tag === 'focus' && b.title === 'Deep Work')).toBe(true);

    const again = await getBlocks(srv, at(T0, '00:00'), at(T2, '23:59'));
    expect(again.filter((b) => b.recurrence_parent_id === tpl.id)).toHaveLength(3); // no double-place
  });

  it('honors the RRULE (weekly BYDAY only fires on listed days)', async () => {
    // A rule that fires only on T1's weekday → exactly one instance in [T0,T2].
    const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${T1}T12:00:00Z`).getUTCDay()];
    const tpl = await makeRecurring(`FREQ=WEEKLY;BYDAY=${weekday}`);
    const blocks = await getBlocks(srv, at(T0, '00:00'), at(T2, '23:59'));
    const insts = blocks.filter((b) => b.recurrence_parent_id === tpl.id);
    expect(insts).toHaveLength(1);
    expect(insts[0].start_at).toBe(at(T1, '09:00'));
  });

  it('carries the template tags (incl. secondary) onto each instance for Phase 5', async () => {
    const tpl = await makeRecurring('FREQ=DAILY', 'UTC', ['email']);
    const blocks = await getBlocks(srv, at(T0, '00:00'), at(T1, '23:59'));
    const inst = blocks.find((b) => b.recurrence_parent_id === tpl.id)!;
    const levels = sqlite
      .prepare(`SELECT t.name AS name, et.level AS level FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_kind='time_block' AND et.entity_id = ? ORDER BY et.level, t.name`)
      .all(inst.id) as { name: string; level: number }[];
    expect(levels).toEqual([{ name: 'focus', level: 1 }, { name: 'email', level: 2 }]);
  });

  it('keeps a stable local wall-clock in a non-UTC timezone across days', async () => {
    const tpl = await makeRecurring('FREQ=DAILY', 'America/New_York');
    const blocks = await getBlocks(srv, at(T0, '00:00'), at(T2, '23:59'));
    const insts = blocks.filter((b) => b.recurrence_parent_id === tpl.id);
    expect(insts.length).toBeGreaterThanOrEqual(2);
    // Compare the wall clock in the rule's zone. New York's DST change moves the UTC
    // hour inside a window that crosses it, while the local time must stay put, so a
    // UTC comparison only holds for windows that do not cross the change.
    const newYorkClock = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const times = new Set(insts.map((b) => newYorkClock.format(new Date(b.start_at))));
    expect(times.size).toBe(1);
  });

  it('deleting one instance EXDATEs it so it does not regenerate on the next read', async () => {
    // The user scenario: a recurring Time Block with no tasks inside ("Deep-focus")
    // could not be deleted — the next GET re-materialized the instance.
    const tpl = await makeRecurring('FREQ=DAILY');
    let blocks = await getBlocks(srv, at(T0, '00:00'), at(T2, '23:59'));
    let insts = blocks.filter((b) => b.recurrence_parent_id === tpl.id);
    expect(insts).toHaveLength(3); // T0, T1, T2

    // Delete the middle occurrence.
    const t1 = insts.find((b) => b.occurrence_date === T1)!;
    expect((await api(srv.url, `/api/blocks/${t1.id}`, { method: 'DELETE' })).status).toBe(200);

    // Its day is now in the template's EXDATE …
    const exRaw = (sqlite.prepare(`SELECT recurrence_exdates FROM time_blocks WHERE id = ?`).get(tpl.id) as { recurrence_exdates: string | null }).recurrence_exdates;
    expect(JSON.parse(exRaw ?? '[]')).toContain(T1);

    // … so the next read keeps it gone (only T0 + T2 remain).
    blocks = await getBlocks(srv, at(T0, '00:00'), at(T2, '23:59'));
    insts = blocks.filter((b) => b.recurrence_parent_id === tpl.id);
    expect(insts.map((b) => b.occurrence_date).sort()).toEqual([T0, T2]);
  });

  it('series rule change re-materializes; deleting the template cascades instances', async () => {
    const tpl = await makeRecurring('FREQ=DAILY');
    await getBlocks(srv, at(T0, '00:00'), at(T2, '23:59'));
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM time_blocks WHERE recurrence_parent_id = ?`).get(tpl.id) as { c: number }).c).toBe(3);

    // Narrow the rule to a single weekday → future instances dropped, re-materialized.
    const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${T0}T12:00:00Z`).getUTCDay()];
    await api(srv.url, `/api/blocks/${tpl.id}`, { method: 'PATCH', json: { recurrence_rule: `FREQ=WEEKLY;BYDAY=${weekday}` } });
    const afterEdit = await getBlocks(srv, at(T0, '00:00'), at(T2, '23:59'));
    expect(afterEdit.filter((b) => b.recurrence_parent_id === tpl.id)).toHaveLength(1); // only T0's weekday

    // Delete the template → instances + their tag rows gone (no orphans).
    await api(srv.url, `/api/blocks/${tpl.id}`, { method: 'DELETE' });
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM time_blocks WHERE recurrence_parent_id = ?`).get(tpl.id) as { c: number }).c).toBe(0);
    const orphans = (sqlite.prepare(
      `SELECT COUNT(*) c FROM entity_tags et WHERE et.entity_kind='time_block' AND NOT EXISTS (SELECT 1 FROM time_blocks WHERE id = et.entity_id)`,
    ).get() as { c: number }).c;
    expect(orphans).toBe(0);
  });
});
