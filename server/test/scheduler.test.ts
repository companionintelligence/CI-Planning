import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runScheduler } from '../src/engine/scheduler.js';
import { addDependency } from '../src/engine/deps.js';
import { resetDb } from './helpers.js';

function insertTask(opts: {
  title: string;
  estimate?: number;
  priority?: number;
  dueAt?: string | null;
  scheduledFor?: string | null;
  deferUntil?: string | null;
}): number {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (title, priority, owner_id, status, estimated_minutes, due_at, scheduled_for, defer_until)
         VALUES (?, ?, 1, 'open', ?, ?, ?, ?) RETURNING id`
      )
      .get(
        opts.title,
        opts.priority ?? 3,
        opts.estimate ?? 60,
        opts.dueAt ?? null,
        opts.scheduledFor ?? null,
        opts.deferUntil ?? null
      ) as { id: number }
  ).id;
}

const DATE = '2026-06-15'; // a PDT (UTC-7) day

function setPrefs(p: { start?: string; end?: string; tz?: string; maxFocus?: number; brk?: number; horizon?: number }) {
  sqlite
    .prepare(
      `UPDATE scheduling_prefs
       SET workday_start = ?, workday_end = ?, timezone = ?, max_focus_block_minutes = ?, min_break_minutes = ?,
           planning_horizon_days = ?
       WHERE owner_id = 1`
    )
    .run(
      p.start ?? '09:00',
      p.end ?? '18:00',
      p.tz ?? 'America/Los_Angeles',
      p.maxFocus ?? 90,
      p.brk ?? 10,
      p.horizon ?? 7
    );
}

function addTask(title: string, estimate: number, priority: number) {
  sqlite
    .prepare(`INSERT INTO tasks (title, priority, owner_id, status, estimated_minutes) VALUES (?, ?, 1, 'open', ?)`)
    .run(title, priority, estimate);
}

function addDatedTask(
  title: string,
  estimate: number,
  priority: number,
  dueAt: string,
  taskTime: string | null = null
) {
  sqlite
    .prepare(
      `INSERT INTO tasks (title, priority, owner_id, status, estimated_minutes, due_at, task_time)
       VALUES (?, ?, 1, 'open', ?, ?, ?)`
    )
    .run(title, priority, estimate, dueAt, taskTime);
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

  it('pins a task with a fixed time-of-day due that day and schedules around it', async () => {
    setPrefs({ start: '09:00', end: '18:00' });
    // Due on 2026-06-15 (PDT) at 13:00 local; 13:00 PDT == 20:00 UTC.
    addDatedTask('Dentist', 60, 2, '2026-06-15T12:00:00.000Z', '13:00');
    addTask('Flex work', 120, 1);

    await runScheduler(DATE);
    const blocks = taskBlocks();

    const pin = blocks.find((b) => b.title === 'Dentist');
    expect(pin).toBeTruthy();
    expect(pin!.start_at).toBe('2026-06-15T20:00:00.000Z');

    // Flexible work never overlaps the pinned appointment.
    const ps = Date.parse('2026-06-15T20:00:00.000Z');
    const pe = Date.parse('2026-06-15T21:00:00.000Z');
    for (const b of blocks.filter((b) => b.title !== 'Dentist')) {
      const s = Date.parse(b.start_at);
      const e = Date.parse(b.end_at);
      expect(s >= pe || e <= ps).toBe(true);
    }
  });

  it('excludes tasks beyond the planning horizon from the day (today set)', async () => {
    setPrefs({ start: '09:00', end: '18:00', horizon: 3 });
    addDatedTask('Due soon', 60, 3, '2026-06-16T12:00:00.000Z'); // within 3-day horizon
    addDatedTask('Far future', 60, 1, '2026-07-30T12:00:00.000Z'); // ~45 days out, urgent
    addTask('Soon', 60, 3); // undated → always a candidate

    const r = await runScheduler(DATE);
    const titles = taskBlocks().map((b) => b.title);

    expect(titles).toContain('Due soon');
    expect(titles).toContain('Soon');
    expect(titles).not.toContain('Far future');
    // Far-future task isn't a candidate, so it doesn't inflate "unscheduled".
    expect(r.unscheduled).toBe(0);
    expect(r.deferred).toBe(1);
  });

  it('bounds the today-set to capacity and rolls the rest over', async () => {
    setPrefs({ start: '09:00', end: '11:00', maxFocus: 90, brk: 10 });
    for (let i = 1; i <= 5; i++) addTask(`Task ${i}`, 60, i);

    const r = await runScheduler(DATE);

    expect(taskBlocks()).toHaveLength(2);
    expect(r.deferred).toBe(3);
    expect(r.unscheduled).toBe(0);
  });

  it('does not schedule a task with an incomplete blocker, then schedules it once done', async () => {
    setPrefs({});
    const blocker = insertTask({ title: 'Blocker' });
    const blocked = insertTask({ title: 'Blocked' });
    addDependency(blocked, blocker); // Blocked depends on Blocker (open)

    const r1 = await runScheduler(DATE);
    let titles = taskBlocks().map((b) => b.title);
    expect(titles).toContain('Blocker');
    expect(titles).not.toContain('Blocked');
    expect(r1.unscheduled).toBe(0); // blocked task isn't "ready", so not counted

    sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(blocker);
    await runScheduler(DATE);
    titles = taskBlocks().map((b) => b.title);
    expect(titles).toContain('Blocked'); // unblocked now
  });

  it('hides a task until its defer_until passes', async () => {
    setPrefs({});
    insertTask({ title: 'Deferred', deferUntil: '2026-12-01T00:00:00.000Z' }); // after the day
    insertTask({ title: 'Ready', deferUntil: '2026-01-01T00:00:00.000Z' }); // already passed

    await runScheduler(DATE);
    const titles = taskBlocks().map((b) => b.title);
    expect(titles).toContain('Ready');
    expect(titles).not.toContain('Deferred');
  });

  it('pulls a far-deadline task into today only when scheduled_for is today', async () => {
    setPrefs({});
    // Both have a far-future hard deadline (beyond horizon); only scheduled_for differs.
    insertTask({ title: 'Intended today', dueAt: '2026-09-01T00:00:00.000Z', scheduledFor: DATE });
    insertTask({ title: 'Intended later', dueAt: '2026-09-01T00:00:00.000Z', scheduledFor: '2026-07-01' });

    await runScheduler(DATE);
    const titles = taskBlocks().map((b) => b.title);
    expect(titles).toContain('Intended today');
    expect(titles).not.toContain('Intended later');
  });
});
