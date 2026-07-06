/**
 * Phase M §C1 — overrun detection on timer stop.
 *
 * When stopRunning closes an entry that is linked to a time_block, it compares
 * the *session* elapsed (ended_at − started_at) against the block's planned span
 * plus a 2-minute tolerance.  If elapsed > span + 120 s the block flips to
 * 'overrun' and StoppedEntry.overran is true; otherwise the block is untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runWithOwner, SYSTEM_OWNER } from '../src/lib/context.js';
import { startTimer, stopTimer } from '../src/services/timer.js';
import { resetDb } from './helpers.js';

const OWNER = SYSTEM_OWNER;

/** Insert a bare task owned by SYSTEM_OWNER and return its id. */
function insertTask(title = 'Overrun task'): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, priority, owner_id, status)
         VALUES (uuid7(), ?, 3, ?, 'open') RETURNING id`
      )
      .get(title, OWNER) as { id: string }
  ).id;
}

/**
 * Insert a time_block spanning [startAt, endAt] (UTC ISO strings) linked to
 * taskId.  Returns the new block's id.
 */
function insertBlock(taskId: string, startAt: string, endAt: string): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, task_id, title, start_at, end_at, status, owner_id)
         VALUES (uuid7(), ?, 'planned block', ?, ?, 'planned', ?) RETURNING id`
      )
      .get(taskId, startAt, endAt, OWNER) as { id: string }
  ).id;
}

/** Read the current status of a time_block row. */
const blockStatus = (blockId: string): string =>
  (
    sqlite
      .prepare(`SELECT status FROM time_blocks WHERE id = ?`)
      .get(blockId) as { status: string }
  ).status;

describe('§C1 overrun detection', () => {
  beforeEach(() => resetDb());

  it('session exceeding block span + tolerance → status=overrun, overran=true', () => {
    const task = insertTask();
    // Block planned for 60 minutes.
    const blockId = insertBlock(
      task,
      '2026-06-20T09:00:00.000Z',
      '2026-06-20T10:00:00.000Z',
    );

    runWithOwner(OWNER, [], () => {
      const { entry } = startTimer(task, blockId);

      // Backdate started_at so the session elapsed is 63 minutes — 1 minute
      // past the 2-minute tolerance (60 + 2 = 62 min threshold).
      const startedAt = new Date(Date.now() - 63 * 60_000).toISOString();
      sqlite
        .prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`)
        .run(startedAt, entry.id);

      const res = stopTimer();
      expect(res).not.toBeNull();
      expect(res!.overran).toBe(true);
    });

    expect(blockStatus(blockId)).toBe('overrun');
  });

  it('session within block span + tolerance → block status unchanged, overran falsy', () => {
    const task = insertTask();
    // Block planned for 60 minutes.
    const blockId = insertBlock(
      task,
      '2026-06-20T09:00:00.000Z',
      '2026-06-20T10:00:00.000Z',
    );

    runWithOwner(OWNER, [], () => {
      const { entry } = startTimer(task, blockId);

      // Session elapsed is 61 minutes — inside the 2-minute tolerance (≤ 62 min).
      const startedAt = new Date(Date.now() - 61 * 60_000).toISOString();
      sqlite
        .prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`)
        .run(startedAt, entry.id);

      const res = stopTimer();
      expect(res).not.toBeNull();
      expect(res!.overran).toBeFalsy();
    });

    expect(blockStatus(blockId)).toBe('planned');
  });

  it('no block_id → no-op (block table untouched)', () => {
    const task = insertTask();

    runWithOwner(OWNER, [], () => {
      const { entry } = startTimer(task); // no blockId

      const startedAt = new Date(Date.now() - 90 * 60_000).toISOString();
      sqlite
        .prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`)
        .run(startedAt, entry.id);

      const res = stopTimer();
      expect(res).not.toBeNull();
      expect(res!.overran).toBeFalsy();
    });

    // No block rows should exist for this task.
    const blockCount = (
      sqlite
        .prepare(`SELECT COUNT(*) AS c FROM time_blocks WHERE task_id = ?`)
        .get(task) as { c: number }
    ).c;
    expect(blockCount).toBe(0);
  });

  it('task-total SUM does NOT drive overrun — only the session span matters', () => {
    // Block planned for 60 minutes.  Two 40-minute sessions: the first session
    // (40 min < 62 min threshold) must NOT overrun; the second (40 min elapsed
    // in that session, even though the task total hits 80 min) must also NOT
    // overrun because 40 < 62.
    const task = insertTask();
    const blockId = insertBlock(
      task,
      '2026-06-20T09:00:00.000Z',
      '2026-06-20T10:00:00.000Z',
    );

    runWithOwner(OWNER, [], () => {
      // --- First session: 40 minutes ---
      const { entry: e1 } = startTimer(task, blockId);
      const start1 = new Date(Date.now() - 40 * 60_000).toISOString();
      sqlite
        .prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`)
        .run(start1, e1.id);
      const res1 = stopTimer();
      expect(res1!.overran).toBeFalsy();
      expect(blockStatus(blockId)).toBe('planned');

      // --- Second session: another 40 minutes (task total would be 80 min) ---
      const { entry: e2 } = startTimer(task, blockId);
      const start2 = new Date(Date.now() - 40 * 60_000).toISOString();
      sqlite
        .prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`)
        .run(start2, e2.id);
      const res2 = stopTimer();
      // 40 min session < 62 min (60 + 2 tolerance) → still not overrun.
      expect(res2!.overran).toBeFalsy();
      expect(blockStatus(blockId)).toBe('planned');
    });
  });
});
