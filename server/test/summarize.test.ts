import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { summarizeDay } from '../src/agents/summarize.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb } from './helpers.js';

const TODAY = '2026-05-30';

function insertTask(title: string, dueAt: string | null, priority = 3, status = 'open') {
  sqlite
    .prepare('INSERT INTO tasks (id, title, due_at, priority, owner_id, status) VALUES (uuid7(), ?, ?, ?, ?, ?)')
    .run(title, dueAt, priority, SYSTEM_OWNER, status);
}

describe('summarize agent', () => {
  beforeEach(() => {
    resetDb();
    // Pin the zone so the day window matches the UTC wall-clock fixtures below,
    // independent of the host's timezone. (TZ correctness is covered in tz.test.ts.)
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(SYSTEM_OWNER);
  });

  it('produces prose + accurate stats (works with or without LLM)', async () => {
    insertTask('Overdue: file taxes', '2026-05-20T12:00:00.000Z', 1);
    insertTask('Due today: send report', `${TODAY}T15:00:00.000Z`, 2);
    insertTask('Backlog: clean inbox', null, 4);

    const summary = await summarizeDay(TODAY);

    expect(summary.date).toBe(TODAY);
    expect(typeof summary.prose).toBe('string');
    expect(summary.prose.length).toBeGreaterThan(0);
    expect(summary.stats.overdue).toBe(1);
    expect(summary.stats.dueToday).toBe(1);
    expect(summary.stats.open).toBeGreaterThanOrEqual(1);
    expect(typeof summary.llm).toBe('boolean');
  });

  it('handles an empty day without throwing', async () => {
    const summary = await summarizeDay(TODAY);
    expect(summary.stats.overdue).toBe(0);
    expect(summary.stats.dueToday).toBe(0);
    expect(summary.prose.length).toBeGreaterThan(0);
  });

  it('counts scheduled blocks for the day', async () => {
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, source_kind, status, owner_id)
         VALUES (uuid7(), 'Standup', 'meeting', ?, ?, 'gcal', 'planned', ?)`
      )
      .run(`${TODAY}T16:00:00.000Z`, `${TODAY}T16:30:00.000Z`, SYSTEM_OWNER);
    const summary = await summarizeDay(TODAY);
    expect(summary.stats.blocks).toBe(1);
  });

  it('caches the briefing until inputs change or refresh is forced', async () => {
    insertTask('Task A', null, 2);

    const first = await summarizeDay(TODAY);
    expect(first.cached).toBeFalsy(); // generated

    const second = await summarizeDay(TODAY);
    expect(second.cached).toBe(true); // served from cache
    expect(second.prose).toBe(first.prose);

    // Changing the day's inputs invalidates the cache (hash changes).
    insertTask('Task B', null, 2);
    const third = await summarizeDay(TODAY);
    expect(third.cached).toBe(false);
    expect(third.stats.open).toBe(2);

    // Unchanged inputs serve cache again…
    expect((await summarizeDay(TODAY)).cached).toBe(true);
    // …but refresh forces a regeneration.
    expect((await summarizeDay(TODAY, { refresh: true })).cached).toBe(false);
  });

  it('produces actionable focus items (overdue → due-today → priority)', async () => {
    insertTask('File taxes', '2026-05-20T12:00:00.000Z', 1); // overdue
    insertTask('Send report', `${TODAY}T15:00:00.000Z`, 2);  // due today
    insertTask('Clean inbox', null, 3);                       // backlog

    const s = await summarizeDay(TODAY, { refresh: true });

    expect(s.focus.length).toBeGreaterThanOrEqual(2);
    expect(s.focus[0].title).toBe('File taxes');
    expect(s.focus[0].reason).toMatch(/Overdue/);
    expect(s.focus.some((f) => f.reason === 'Due today')).toBe(true);
    expect(s.focus.length).toBeLessThanOrEqual(3); // capped at three
  });

  it('includes capacity: scheduled_minutes, focus_minutes, workday_minutes', async () => {
    // Scheduled blocks: 30 min standup + 60 min deep work = 90 min
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, status, owner_id)
         VALUES (uuid7(), 'Standup', 'meeting', ?, ?, 'done', ?),
                (uuid7(), 'Deep Work', 'task', ?, ?, 'done', ?)`
      )
      .run(
        `${TODAY}T09:00:00.000Z`, `${TODAY}T09:30:00.000Z`, SYSTEM_OWNER,
        `${TODAY}T10:00:00.000Z`, `${TODAY}T11:00:00.000Z`, SYSTEM_OWNER,
      );

    // A focused task with estimated_minutes — it'll appear in focus[]
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, priority, status, due_at, estimated_minutes)
         VALUES (uuid7(), 'Tax filing', ?, 1, 'open', '2026-05-01T12:00:00.000Z', 45)`
      )
      .run(SYSTEM_OWNER);

    const s = await summarizeDay(TODAY, { refresh: true });

    expect(s.capacity).toBeDefined();
    expect(s.capacity.scheduled_minutes).toBe(90);
    expect(s.capacity.focus_minutes).toBe(45); // sum of estimated_minutes for focus tasks
    // Default workday: 09:00–18:00 UTC = 540 min (pinned by prefs reset)
    expect(s.capacity.workday_minutes).toBe(540);
  });

  it('capacity.scheduled_minutes is 0 for an empty day', async () => {
    const s = await summarizeDay(TODAY, { refresh: true });
    expect(s.capacity.scheduled_minutes).toBe(0);
    expect(s.capacity.focus_minutes).toBe(0);
    expect(s.capacity.workday_minutes).toBe(540);
  });
});
