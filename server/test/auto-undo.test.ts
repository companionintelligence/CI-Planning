import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { placeFlightPlan, fillByPriority, undoLastAuto } from '../src/engine/autoplan.js';
import { resetDb } from './helpers.js';

/**
 * Undo (req 2, D2): one click reverts the LAST placement run only. Targets the run's
 * stamped blocks (auto_run_id), re-stages those tasks, and is single-step (a second
 * undo is a no-op). Never touches manual or meeting blocks.
 */
const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function insertTask(title: string, est = 30, tag?: string, priority = 3): string {
  const id = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, ?) RETURNING id`).get(title, OWNER, est, priority) as { id: string }).id;
  if (tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id`).get(tag) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}
const stage = (taskId: string) => sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
const makePlan = (tag: string, start: string, end: string) =>
  (sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status) VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', ?, ?, ?, 0, 'manual', 'planned') RETURNING id`).get(tag, start, end) as { id: string }).id;
const agentTaskBlocks = () =>
  (sqlite.prepare(`SELECT title FROM time_blocks WHERE block_kind = 'task' AND source_kind = 'agent'`).all() as { title: string }[]).map((b) => b.title);
const fpRow = (taskId: string) =>
  sqlite.prepare(`SELECT selected FROM flight_plan WHERE owner_id = ? AND task_id = ?`).get(OWNER, taskId) as { selected: number } | undefined;

beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone='UTC', workday_start='09:00', workday_end='18:00', auto_fill_workday=1 WHERE owner_id=?`).run(OWNER);
});

describe('undoLastAuto', () => {
  it('place then undo restores prior state and re-stages the task', () => {
    makePlan('work', at('09:00'), at('12:00'));
    const t = insertTask('Code', 60, 'work');
    stage(t);

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.blocksCreated).toBeGreaterThanOrEqual(1);
    expect(agentTaskBlocks()).toContain('Code');

    const u = undoLastAuto(OWNER);
    expect(u.removed).toBeGreaterThanOrEqual(1);
    expect(u.restaged).toBe(1);
    expect(agentTaskBlocks()).not.toContain('Code'); // run's blocks gone
    expect(fpRow(t)?.selected).toBe(1); // task re-staged, selected
  });

  it('is single-step: a second undo is a no-op', () => {
    makePlan('work', at('09:00'), at('12:00'));
    stage(insertTask('Code', 60, 'work'));
    placeFlightPlan(OWNER, { date: DAY });

    expect(undoLastAuto(OWNER).removed).toBeGreaterThanOrEqual(1);
    const second = undoLastAuto(OWNER);
    expect(second).toEqual({ removed: 0, restaged: 0 });
  });

  it('undo removes all blocks from the combined run (Plans + workday fill share one run_id)', () => {
    makePlan('work', at('09:00'), at('12:00'));
    stage(insertTask('Code', 60, 'work')); // tag-matched → Plan
    stage(insertTask('Loose', 30));         // untagged → workday fill

    // placeFlightPlan now covers Plans + workday fill in a single run.
    placeFlightPlan(OWNER, { date: DAY });
    expect(agentTaskBlocks().sort()).toEqual(['Code', 'Loose']);

    undoLastAuto(OWNER); // removes all blocks from the combined run
    expect(agentTaskBlocks()).toEqual([]); // both blocks gone — they share the same run_id
  });

  it('never touches manual or meeting blocks', () => {
    sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, status) VALUES (uuid7(), 'Manual', 'task', ?, ?, 0, 'manual', 'planned')`).run(at('09:00'), at('10:00'));
    sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, source_ref, status) VALUES (uuid7(), 'Mtg', 'meeting', ?, ?, 1, 'gcal', 'e1', 'planned')`).run(at('11:00'), at('12:00'));
    stage(insertTask('Loose', 30));
    fillByPriority(OWNER, { date: DAY });

    undoLastAuto(OWNER);
    const titles = (sqlite.prepare(`SELECT title FROM time_blocks`).all() as { title: string }[]).map((b) => b.title);
    expect(titles).toContain('Manual');
    expect(titles).toContain('Mtg');
    expect(titles).not.toContain('Loose'); // only the run's block was removed
  });
});
