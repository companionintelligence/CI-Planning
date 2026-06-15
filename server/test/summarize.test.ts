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
});
