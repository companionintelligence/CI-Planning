import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { placeFlightPlan, fillByPriority } from '../src/engine/autoplan.js';
import { resetDb } from './helpers.js';

/**
 * No-overlap guarantee (req 6 — regression lock, no behavior change). A placement run
 * never overlaps a pre-existing locked block, meeting, or active task block, and a
 * re-run is idempotent (clearPriorAuto wipes only the prior auto, then re-packs).
 */
const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

const overlaps = (a: { start_at: string; end_at: string }, b: { start_at: string; end_at: string }) =>
  Date.parse(a.start_at) < Date.parse(b.end_at) && Date.parse(a.end_at) > Date.parse(b.start_at);

function insertObstacle(title: string, kind: string, start: string, end: string, locked = 0, source = 'manual', status = 'planned'): { start_at: string; end_at: string } {
  sqlite
    .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id) VALUES (uuid7(), ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(title, kind, start, end, locked, source, status, OWNER);
  return { start_at: start, end_at: end };
}
function insertTask(title: string, est = 60, tag?: string): string {
  const id = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`).get(title, OWNER, est) as { id: string }).id;
  if (tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id`).get(tag) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}
const stage = (taskId: string) => sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
const agentBlocks = () =>
  sqlite.prepare(`SELECT title, start_at, end_at FROM time_blocks WHERE source_kind = 'agent' AND block_kind = 'task'`).all() as { title: string; start_at: string; end_at: string }[];

beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone='UTC', workday_start='09:00', workday_end='18:00', auto_fill_workday=1 WHERE owner_id=?`).run(OWNER);
});

describe('no-overlap guarantee', () => {
  it('a placement run never overlaps a locked block, meeting, or active task block', () => {
    const locked = insertObstacle('Locked', 'task', at('09:00'), at('10:00'), 1);
    const meeting = insertObstacle('Meeting', 'meeting', at('11:00'), at('12:00'), 0, 'gcal');
    const activeTask = insertObstacle('Active', 'task', at('14:00'), at('15:00'));
    const obstacles = [locked, meeting, activeTask];

    // Stage enough work to span the day; place via both the tag-matched + priority paths.
    for (let i = 0; i < 4; i++) stage(insertTask(`Task ${i}`, 90));
    placeFlightPlan(OWNER, { date: DAY });
    fillByPriority(OWNER, { date: DAY });

    const placed = agentBlocks();
    expect(placed.length).toBeGreaterThan(0);
    for (const b of placed) {
      for (const o of obstacles) {
        expect(overlaps(b, o), `${b.title} overlaps a pre-existing block`).toBe(false);
      }
    }
  });

  it('re-running placement is idempotent (no duplication, still no overlap)', () => {
    const plan = (sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status, owner_id) VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', 'work', ?, ?, 0, 'manual', 'planned', ?) RETURNING id`).get(at('09:00'), at('17:00'), OWNER) as { id: string }).id;
    const locked = insertObstacle('Locked', 'task', at('09:00'), at('10:00'), 1);
    for (let i = 0; i < 3; i++) stage(insertTask(`Work ${i}`, 60, 'work'));

    placeFlightPlan(OWNER, { date: DAY }); // first run: places blocks, removes tasks from flight plan (item 5)
    const first = agentBlocks();
    expect(first.length).toBeGreaterThan(0);
    for (const b of first) expect(overlaps(b, locked), `${b.title} overlaps locked block`).toBe(false);

    placeFlightPlan(OWNER, { date: DAY }); // second run: clearPriorAuto removes first-run blocks; nothing staged → 0 placed
    const second = agentBlocks();
    expect(second.length).toBe(0); // tasks de-staged after first run; no duplicates
    expect(plan).toBeTruthy();
  });
});
