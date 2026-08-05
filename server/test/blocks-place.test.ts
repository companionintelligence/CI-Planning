import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';
import { placeTasksInBlock } from '../src/engine/blocks-place.js';

/**
 * "Add existing tasks to a Time-Block" — placeTasksInBlock scatters chosen tasks into a
 * scheduled container's free gaps as child task blocks (parent_block_id set), reusing the
 * scheduler gap math. Source is 'manual' (user-placed), and existing children act as
 * obstacles so new tasks never overlap them.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function insertContainer(startISO: string, endISO: string): string {
  return (sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, block_type, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
       VALUES (uuid7(), 'Focus', 'timeblock', 'scheduled', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
    )
    .get(startISO, endISO, OWNER) as { id: string }).id;
}
function insertTask(title: string, est = 30): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
    .get(title, OWNER, est) as { id: string }).id;
}
function insertChild(parentId: string, taskId: string, startISO: string, endISO: string): void {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, parent_block_id, owner_id)
       VALUES (uuid7(), ?, 'pre', 'task', ?, ?, 0, 0, 'manual', 'planned', ?, ?)`,
    )
    .run(taskId, startISO, endISO, parentId, OWNER);
}
const childrenOf = (blockId: string) =>
  sqlite
    .prepare(`SELECT task_id, title, start_at, end_at, block_kind, source_kind, is_auto FROM time_blocks WHERE parent_block_id = ? ORDER BY start_at`)
    .all(blockId) as { task_id: string; title: string; start_at: string; end_at: string; block_kind: string; source_kind: string; is_auto: number }[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', min_break_minutes = 10, max_focus_block_minutes = 90 WHERE owner_id = ?`).run(OWNER);
});

describe('placeTasksInBlock', () => {
  it('scatters tasks into the container as non-overlapping child blocks', async () => {
    const c = insertContainer(at('09:00'), at('12:00'));
    const t1 = insertTask('Write A', 30);
    const t2 = insertTask('Write B', 30);

    const r = await placeTasksInBlock(OWNER, c, [t1, t2]);
    expect(r.placed).toBe(2);
    expect(r.blocksCreated).toBe(2);

    const kids = childrenOf(c);
    expect(kids.map((k) => k.task_id).sort()).toEqual([t1, t2].sort());
    // Each child is a task block, user-placed (manual / not auto), inside the window.
    for (const k of kids) {
      expect(k.block_kind).toBe('task');
      expect(k.source_kind).toBe('manual');
      expect(k.is_auto).toBe(0);
      expect(k.start_at >= at('09:00')).toBe(true);
      expect(k.end_at <= at('12:00')).toBe(true);
    }
    // No overlap between the two placements.
    expect(kids[0].end_at <= kids[1].start_at).toBe(true);
  });

  it('flips a placed task to scheduled AND mirrors scheduled_for/task_time onto it', async () => {
    const c = insertContainer(at('09:00'), at('12:00'));
    const t = insertTask('Write A', 30);
    await placeTasksInBlock(OWNER, c, [t]);
    const row = sqlite.prepare(`SELECT status, scheduled_for, task_time FROM tasks WHERE id = ?`).get(t) as
      { status: string; scheduled_for: string | null; task_time: string | null };
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_for).toBe(DAY);   // 09:00 UTC, tz=UTC → same local day
    expect(row.task_time).toBe('09:00');   // mirrored from the earliest placement
  });

  it('treats an existing child as an obstacle (new task lands after it, with a break)', async () => {
    const c = insertContainer(at('09:00'), at('12:00'));
    const pre = insertTask('Existing', 60);
    insertChild(c, pre, at('09:00'), at('10:00')); // occupies 09:00–10:00
    const t = insertTask('New', 30);

    await placeTasksInBlock(OWNER, c, [t]);

    const placed = childrenOf(c).find((k) => k.task_id === t)!;
    // min_break_minutes = 10 → first free slot starts at 10:10.
    expect(placed.start_at).toBe(at('10:10'));
    expect(placed.end_at).toBe(at('10:40'));
  });

  it('skips ids already attached, duplicates, and an empty list (idempotent re-add)', async () => {
    const c = insertContainer(at('09:00'), at('12:00'));
    const t = insertTask('Once', 30);

    const first = await placeTasksInBlock(OWNER, c, [t, t]); // duplicate in one call
    expect(first.placed).toBe(1);
    expect(first.skipped).toBe(1);
    expect(childrenOf(c)).toHaveLength(1);

    const again = await placeTasksInBlock(OWNER, c, [t]); // already a child
    expect(again.blocksCreated).toBe(0);
    expect(again.skipped).toBe(1);
    expect(childrenOf(c)).toHaveLength(1);

    expect((await placeTasksInBlock(OWNER, c, [])).blocksCreated).toBe(0); // empty list → no-op
  });

  it('is a no-op for a non-container or a zero-length / someday block', async () => {
    const someday = insertContainer(at('09:00'), at('09:00')); // zero-length window
    const t = insertTask('X', 30);
    expect((await placeTasksInBlock(OWNER, someday, [t])).blocksCreated).toBe(0);
    expect(childrenOf(someday)).toHaveLength(0);

    // A plain task block (not a container) accepts nothing.
    const taskBlockId = (sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, source_kind, status, owner_id) VALUES (uuid7(), 'loose', 'task', ?, ?, 'manual', 'planned', ?) RETURNING id`)
      .get(at('09:00'), at('09:30'), OWNER) as { id: string }).id;
    expect((await placeTasksInBlock(OWNER, taskBlockId, [t])).blocksCreated).toBe(0);
  });
});
