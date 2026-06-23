import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { autoScheduleOnIngest, autoMode } from '../src/engine/autoplan.js';
import { resetDb } from './helpers.js';

/**
 * Trust toggle (req 1, D1). Schedule mode collapses taps 1+2 on ingest (zero-click,
 * tag-matched placement in the background); suggest mode is a no-op (the user drives
 * the taps). The explicit priority top-up is never run here.
 */
const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-22';

function setMode(mode: 'suggest' | 'schedule'): void {
  sqlite.prepare(`UPDATE scheduling_prefs SET auto_mode = ? WHERE owner_id = ?`).run(mode, OWNER);
}

/** A tagged, scheduled Plan container on DATE (what pass-1 places tag-matched work into). */
function makePlan(tag: string, start: string, end: string): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status)
         VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', ?, ?, ?, 0, 'manual', 'planned') RETURNING id`,
      )
      .get(tag, start, end) as { id: string }
  ).id;
}

function makeTask(title: string, tag: string, est = 30): string {
  const id = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`).get(title, OWNER, est) as { id: string }).id;
  let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
  if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name, kind) VALUES (uuid7(), ?, 'pattern') RETURNING id`).get(tag) as { id: string };
  sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  return id;
}

const taskBlocks = () =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1`).get() as { n: number }).n;

beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
});

describe('autoScheduleOnIngest (D1)', () => {
  it('schedule mode places tag-matched work in one pass', () => {
    setMode('schedule');
    expect(autoMode(OWNER)).toBe('schedule');
    const plan = makePlan('errands', `${DATE}T16:00:00.000Z`, `${DATE}T18:00:00.000Z`);
    makeTask('Post office', 'errands');

    const result = autoScheduleOnIngest(OWNER, { date: DATE });
    expect(result?.step).toBe('place');
    expect(taskBlocks()).toBeGreaterThanOrEqual(1);
    const placed = sqlite.prepare(`SELECT parent_block_id FROM time_blocks WHERE title = 'Post office'`).get() as { parent_block_id: string | null };
    expect(placed.parent_block_id).toBe(plan); // routed into the matching Plan
  });

  it('suggest mode is a no-op on ingest (no staging, no placement)', () => {
    setMode('suggest');
    makePlan('errands', `${DATE}T16:00:00.000Z`, `${DATE}T18:00:00.000Z`);
    makeTask('Post office', 'errands');

    const result = autoScheduleOnIngest(OWNER, { date: DATE });
    expect(result).toBeNull();
    expect(taskBlocks()).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ?`).get(OWNER) as { n: number }).n).toBe(0);
  });
});
