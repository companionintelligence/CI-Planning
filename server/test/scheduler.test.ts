import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runScheduler } from '../src/engine/scheduler.js';
import { resetDb } from './helpers.js';

const DATE = '2026-06-15'; // a PDT (UTC-7) day

function setPrefs(p: { start?: string; end?: string; tz?: string; maxFocus?: number; brk?: number }) {
  sqlite
    .prepare(
      `UPDATE scheduling_prefs
       SET workday_start = ?, workday_end = ?, timezone = ?, max_focus_block_minutes = ?, min_break_minutes = ?
       WHERE owner_id = 1`
    )
    .run(p.start ?? '09:00', p.end ?? '18:00', p.tz ?? 'America/Los_Angeles', p.maxFocus ?? 90, p.brk ?? 10);
}

function addTask(title: string, estimate: number, priority: number) {
  sqlite
    .prepare(`INSERT INTO tasks (title, priority, owner_id, status, estimated_minutes) VALUES (?, ?, 1, 'open', ?)`)
    .run(title, priority, estimate);
}

interface BlockRow { title: string; start_at: string; end_at: string }
function taskBlocks(): BlockRow[] {
  return sqlite
    .prepare(`SELECT title, start_at, end_at FROM time_blocks WHERE block_kind = 'task' ORDER BY start_at ASC`)
    .all() as BlockRow[];
}
const durMin = (b: BlockRow) => (new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / 60_000;

describe('scheduler', () => {
  beforeEach(() => resetDb());

  it('places blocks at the local workday start, not UTC midnight', async () => {
    setPrefs({ start: '09:00', tz: 'America/Los_Angeles' });
    addTask('Deep work', 60, 1);

    const r = await runScheduler(DATE);

    expect(r.blocksCreated).toBe(1);
    // 09:00 PDT == 16:00 UTC — the bug placed this at 09:00Z (= 02:00 local).
    expect(taskBlocks()[0].start_at).toBe('2026-06-15T16:00:00.000Z');
  });

  it('splits a task longer than the focus cap into labeled sessions (no lost time)', async () => {
    setPrefs({ maxFocus: 90, brk: 10 });
    addTask('Big project', 180, 1);

    const r = await runScheduler(DATE);

    const blocks = taskBlocks();
    expect(r.blocksCreated).toBe(2);
    expect(r.tasksScheduled).toBe(1);
    expect(blocks.map((b) => b.title)).toEqual(['Big project (1/2)', 'Big project (2/2)']);
    // The full 180 minutes is scheduled — nothing silently vanishes.
    expect(durMin(blocks[0]) + durMin(blocks[1])).toBe(180);
  });

  it('backfills an earlier gap a bigger, higher-priority task skipped', async () => {
    // Workday 09:00–12:00 PDT with a locked meeting 10:00–10:30 PDT (17:00–17:30Z)
    // → gaps: 09:00–10:00 (60m) and 10:40–12:00 (80m, after a 10m break).
    setPrefs({ start: '09:00', end: '12:00', maxFocus: 90, brk: 10 });
    sqlite
      .prepare(
        `INSERT INTO time_blocks (title, block_kind, start_at, end_at, is_locked, is_auto, status)
         VALUES ('Standup', 'meeting', ?, ?, 1, 0, 'planned')`
      )
      .run('2026-06-15T17:00:00.000Z', '2026-06-15T17:30:00.000Z');

    addTask('Big', 80, 1);   // only fits the 80m gap
    addTask('Small', 50, 2); // lower priority, fits the skipped 60m gap

    const r = await runScheduler(DATE);
    const blocks = taskBlocks();

    expect(r.blocksCreated).toBe(2);
    // The earliest task block is the lower-priority Small task backfilling the
    // 09:00 gap the Big task couldn't use (the old forward-only packer left it open).
    expect(blocks[0].title).toBe('Small');
    expect(blocks[0].start_at).toBe('2026-06-15T16:00:00.000Z'); // 09:00 PDT
    // No task block overlaps the locked meeting.
    const meetingStart = Date.parse('2026-06-15T17:00:00.000Z');
    const meetingEnd = Date.parse('2026-06-15T17:30:00.000Z');
    for (const b of blocks) {
      const s = Date.parse(b.start_at);
      const e = Date.parse(b.end_at);
      expect(s >= meetingEnd || e <= meetingStart).toBe(true);
    }
  });
});
