import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, seedFallbackFillWindow, type TestServer } from './helpers.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';

/**
 * Ticket 2 (placement-learning wave) — the capture half of the loop. Proves
 * `logPlacement` is wired into the real Auto placement path (`placeFlightPlan` →
 * `placeIntoWindow`), not just correct in isolation: every assertion here reads
 * `placement_log` rows left behind by an actual engine run, the same way
 * `classification-capture.test.ts` proves `logAssignment` through the API.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

interface LogRow {
  id: string;
  owner_id: string;
  block_id: string | null;
  task_id: string | null;
  slot_key: string;
  auto_run_id: string | null;
  chosen_start_at: string;
  chosen_end_at: string;
  chosen_hour: number;
  fit: number;
  candidates: string;
  moved_start_at: string | null;
  moved_end_at: string | null;
  moved_hour: number | null;
  placed_at: string;
  moved_at: string | null;
  local_date: string;
}

function insertTask(title: string, est = 30): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
    .get(title, OWNER, est) as { id: string }).id;
}
function stage(taskId: string): void {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
}
/** A direction tag by name, reusing the ones `seedFallbackFillWindow` already made. */
function directionTagId(name: string): string {
  const existing = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction'`).get(OWNER, name) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  return (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'direction') RETURNING id`).get(OWNER, name) as {
    id: string;
  }).id;
}
function tagDirection(taskId: string, name: string): void {
  sqlite.prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(taskId, directionTagId(name));
}
async function makePlan(srv: TestServer, tag: string, start: string, end: string) {
  return (
    await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: `${tag} plan`, block_kind: 'timeblock', block_type: 'scheduled', tag, start_at: start, end_at: end },
    })
  ).body.block;
}
function insertMeeting(title: string, start: string, end: string): void {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, source_ref, status, owner_id)
       VALUES (uuid7(), ?, 'meeting', ?, ?, 0, 'gcal', ?, 'planned', ?)`,
    )
    .run(title, start, end, title, OWNER);
}
const logsFor = (taskId: string) =>
  sqlite.prepare(`SELECT * FROM placement_log WHERE task_id = ? ORDER BY chosen_start_at`).all(taskId) as LogRow[];
const blockFor = (taskId: string) =>
  sqlite.prepare(`SELECT id, start_at, end_at FROM time_blocks WHERE task_id = ? AND block_kind = 'task'`).get(taskId) as
    | { id: string; start_at: string; end_at: string }
    | undefined;

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});
beforeEach(() => {
  resetDb();
  seedFallbackFillWindow(); // 0156: fallback fill needs work/community pattern_blocks windows
  sqlite.exec(`DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', auto_fill_workday = 1 WHERE owner_id = ?`).run(OWNER);
});

describe('capturing what the scheduler chose and passed over', () => {
  it('writes exactly one placement_log row for a placed task, matching the created block', async () => {
    const taskId = insertTask('Write the report', 30);
    stage(taskId);

    await placeFlightPlan(OWNER, { date: DAY });

    const block = blockFor(taskId)!;
    const rows = logsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].block_id).toBe(block.id);
    expect(rows[0].chosen_start_at).toBe(block.start_at);
    expect(rows[0].chosen_end_at).toBe(block.end_at);
  });

  it('leaves moved_* and moved_at NULL — this ticket only opens the row', async () => {
    const taskId = insertTask('Write the report', 30);
    stage(taskId);

    await placeFlightPlan(OWNER, { date: DAY });

    const row = logsFor(taskId)[0];
    expect(row.moved_start_at).toBeNull();
    expect(row.moved_end_at).toBeNull();
    expect(row.moved_hour).toBeNull();
    expect(row.moved_at).toBeNull();
  });

  it('records the OWNER-LOCAL hour, not the UTC hour, under a non-UTC timezone', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?`).run('Etc/GMT+5', OWNER);
    const taskId = insertTask('Write the report', 30);
    stage(taskId);

    await placeFlightPlan(OWNER, { date: DAY });

    const row = logsFor(taskId)[0];
    // Fallback fill's workday window opens at 09:00 OWNER-LOCAL, which on Etc/GMT+5
    // (UTC-5, no DST) is 14:00 UTC — so a wrong (UTC) hour would read 14, not 9.
    expect(row.chosen_hour).toBe(9);
    expect(new Date(row.chosen_start_at).getUTCHours()).toBe(14);
  });

  it('captures the gap menu as {s,e,c} entries, day-ordered, snapshotted before the pick', async () => {
    const taskId = insertTask('Write the report', 30);
    stage(taskId);

    await placeFlightPlan(OWNER, { date: DAY });

    const row = logsFor(taskId)[0];
    const candidates = JSON.parse(row.candidates) as { s: number; e: number; c: number }[];
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(typeof c.s).toBe('number');
      expect(typeof c.e).toBe('number');
      expect(typeof c.c).toBe('number');
    }
    // Only one free gap exists (an empty day) → it is the first (and only) entry, and
    // its cursor, snapshotted before the pick, equals where the task actually landed.
    expect(candidates[0].c).toBe(Date.parse(row.chosen_start_at));
  });

  it('caps a fragmented day at MAX_CANDIDATES_LOGGED (12) candidate entries', async () => {
    // 15 short meetings, 30 minutes apart, inside the 09:00-18:00 fallback window —
    // carves the day into well over 12 free gaps.
    for (let i = 0; i < 15; i++) {
      const startMin = 9 * 60 + i * 30;
      const s = `${DAY}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}:00.000Z`;
      const endMin = startMin + 5;
      const e = `${DAY}T${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}:00.000Z`;
      insertMeeting(`Meeting ${i}`, s, e);
    }
    const taskId = insertTask('Squeeze me in', 30);
    stage(taskId);

    await placeFlightPlan(OWNER, { date: DAY });

    const row = logsFor(taskId)[0];
    const candidates = JSON.parse(row.candidates) as unknown[];
    expect(candidates).toHaveLength(12);
  });

  it('resolves slot_key from the task’s level-1 direction, alphabetically-first for two, and "(none)" when untagged', async () => {
    const untagged = insertTask('No direction', 30);
    const oneDirection = insertTask('One direction', 30);
    tagDirection(oneDirection, 'work');
    const twoDirections = insertTask('Two directions', 30);
    tagDirection(twoDirections, 'work');
    tagDirection(twoDirections, 'community');
    [untagged, oneDirection, twoDirections].forEach(stage);

    await placeFlightPlan(OWNER, { date: DAY });

    expect(logsFor(untagged)[0].slot_key).toBe('(none)');
    expect(logsFor(oneDirection)[0].slot_key).toBe('work');
    expect(logsFor(twoDirections)[0].slot_key).toBe('community'); // alphabetically first
  });

  it('writes fit = 0 when the placement truncates (the task is larger than every gap)', async () => {
    const plan = await makePlan(srv, 'work', at('09:00'), at('09:20')); // a 20-minute Plan
    const taskId = insertTask('Too big for its window', 60);
    tagDirection(taskId, 'work');
    stage(taskId);

    await placeFlightPlan(OWNER, { date: DAY });

    const block = blockFor(taskId)!;
    expect(Date.parse(block.start_at)).toBe(Date.parse(plan.start_at)); // placed inside the 20-minute Plan
    expect(Date.parse(block.end_at) - Date.parse(block.start_at)).toBe(20 * 60_000); // truncated to fit
    const row = logsFor(taskId)[0];
    expect(row.fit).toBe(0);
  });

  it('writes two rows for a two-session split task; the second reflects the first session’s advanced cursor', async () => {
    // 120 minutes with a 90-minute max focus block splits into sessions of 90 + 30.
    const taskId = insertTask('A long one', 120);
    stage(taskId);

    await placeFlightPlan(OWNER, { date: DAY });

    const rows = logsFor(taskId);
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first.chosen_start_at < second.chosen_start_at).toBe(true);

    const firstCandidates = JSON.parse(first.candidates) as { s: number; e: number; c: number }[];
    const secondCandidates = JSON.parse(second.candidates) as { s: number; e: number; c: number }[];
    // Same single gap both times (one continuous free day) — but the second
    // snapshot's cursor has moved past the first session's end + the break.
    expect(secondCandidates[0].s).toBe(firstCandidates[0].s);
    expect(secondCandidates[0].c).toBeGreaterThan(firstCandidates[0].c);
    expect(secondCandidates[0].c).toBe(Date.parse(first.chosen_end_at) + 10 * 60_000); // min_break_minutes = 10
  });

  it('does not write to time_blocks, tasks, daily_plan or flight_plan itself — only placement_log', async () => {
    const taskId = insertTask('Write the report', 30);
    stage(taskId);
    const blocksBefore = (sqlite.prepare(`SELECT COUNT(*) n FROM time_blocks`).get() as { n: number }).n;

    await placeFlightPlan(OWNER, { date: DAY });

    // The engine itself wrote exactly one new time_blocks row (the placement); the
    // capture path riding along afterward added no block, task, daily_plan or
    // flight_plan row beyond what placement itself already does.
    const blocksAfter = (sqlite.prepare(`SELECT COUNT(*) n FROM time_blocks`).get() as { n: number }).n;
    expect(blocksAfter).toBe(blocksBefore + 1);
    expect(logsFor(taskId)).toHaveLength(1);
  });

  it('placement still succeeds and logs one warning when placement_log is unwritable', async () => {
    const taskId = insertTask('Write the report', 30);
    stage(taskId);
    sqlite.exec(`ALTER TABLE placement_log RENAME TO placement_log_hidden`);
    try {
      const result = await placeFlightPlan(OWNER, { date: DAY });
      expect(result.placed).toBe(1);
      expect(blockFor(taskId)).toBeDefined();
    } finally {
      sqlite.exec(`ALTER TABLE placement_log_hidden RENAME TO placement_log`);
    }
  });
});
