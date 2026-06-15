import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { summarizeDay } from '../src/agents/summarize.js';
import { resetDb } from './helpers.js';

const TODAY = '2026-05-30';

function insertTask(title: string, dueAt: string | null, priority = 3, status = 'open') {
  sqlite
    .prepare('INSERT INTO tasks (title, due_at, priority, owner_id, status) VALUES (?, ?, ?, 1, ?)')
    .run(title, dueAt, priority, status);
}

describe('summarize agent', () => {
  beforeEach(() => {
    resetDb();
    // Pin the zone so the day window matches the UTC wall-clock fixtures below,
    // independent of the host's timezone. (TZ correctness is covered in tz.test.ts.)
    sqlite.exec(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = 1`);
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
        `INSERT INTO time_blocks (title, block_kind, start_at, end_at, source_kind, status)
         VALUES ('Standup', 'meeting', ?, ?, 'gcal', 'planned')`
      )
      .run(`${TODAY}T16:00:00.000Z`, `${TODAY}T16:30:00.000Z`);
    const summary = await summarizeDay(TODAY);
    expect(summary.stats.blocks).toBe(1);
  });

  it('surfaces actionable focus items, most urgent first', async () => {
    insertTask('File the overdue taxes', '2026-05-20T12:00:00.000Z', 1);
    insertTask('Send the report due today', `${TODAY}T15:00:00.000Z`, 2);

    const summary = await summarizeDay(TODAY);

    expect(summary.focus.length).toBeGreaterThanOrEqual(2);
    expect(summary.focus[0].title).toBe('File the overdue taxes');
    expect(summary.focus[0].reason).toMatch(/overdue/i);
    expect(summary.focus.some((f) => f.reason === 'Due today')).toBe(true);
    // Every focus item points at a real task id.
    for (const f of summary.focus) expect(f.taskId).toBeGreaterThan(0);
  });

  it('caches the briefing per day and only regenerates on demand', async () => {
    insertTask('Something to brief about', null, 2);
    await summarizeDay(TODAY); // populates the cache

    // Tamper with the stored prose; a cache hit must return the tampered value.
    sqlite.prepare(`UPDATE daily_summaries SET prose = 'CACHED MARKER' WHERE date = ?`).run(TODAY);
    const hit = await summarizeDay(TODAY);
    expect(hit.prose).toBe('CACHED MARKER');

    // refresh bypasses the cache and rewrites it.
    const fresh = await summarizeDay(TODAY, { refresh: true });
    expect(fresh.prose).not.toBe('CACHED MARKER');
    const after = await summarizeDay(TODAY);
    expect(after.prose).not.toBe('CACHED MARKER');
  });

  it('invalidates the cache when the day\'s tasks change', async () => {
    await summarizeDay(TODAY);
    sqlite.prepare(`UPDATE daily_summaries SET prose = 'STALE' WHERE date = ?`).run(TODAY);

    insertTask('A new task changes the inputs', null, 1); // hash no longer matches
    const summary = await summarizeDay(TODAY);
    expect(summary.prose).not.toBe('STALE');
  });
});
