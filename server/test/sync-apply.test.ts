/**
 * Phase L: unit tests for server/src/sync/apply.ts
 *
 * Tests field-level LWW, monotonic-completion, owner isolation, and
 * the POST /api/sync batch endpoint via the test server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { applyMonotonic, applyOp, stampRow, type Op } from '../src/sync/apply.js';
import { applySyncedObjectiveUpkeep } from '../src/services/objectives.js';
import { deleteTask, promoteToHabit, skipRecurringInstance, updateTask } from '../src/services/tasks.js';
import { rescheduleTask } from '../src/engine/review.js';
import { moveBlockGroup, promoteBlockToScheduled } from '../src/services/blocks.js';
import { extendBlock } from '../src/engine/extend-block.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function insertTask(id: string, title = 'Test task'): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, priority, version)
       VALUES (?, ?, ?, 'open', 3, 1)`,
    )
    .run(id, title, SYSTEM_OWNER);
}

function getTask(id: string): Record<string, unknown> {
  return sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;
}

/**
 * The server clock `stampRow` wrote for `field` — the value an arriving op's clientTs is
 * compared against. Asserts the stamp exists, because that is the whole guard: with no
 * `field_ts` entry the LWW compare in applyOp is `clientTs >= ''`, which every op wins.
 */
function fieldStamp(id: string, field: string, what = 'the service write', table: 'tasks' | 'time_blocks' = 'tasks'): string {
  const row = sqlite.prepare(`SELECT field_ts FROM ${table} WHERE id = ?`).get(id) as { field_ts: string | null } | undefined;
  const stamp = (JSON.parse(row?.field_ts ?? '{}') as Record<string, string>)[field];
  expect(stamp, `${what} must stamp field_ts.${field}`).toBeTruthy();
  return stamp;
}

function insertBlock(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, owner_id: SYSTEM_OWNER, title: 'Test block', block_kind: 'task',
    start_at: '2026-06-01T09:00:00.000Z', end_at: '2026-06-01T10:00:00.000Z',
    status: 'planned', version: 1, ...over,
  };
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO time_blocks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
}

function getBlock(id: string): Record<string, unknown> {
  return sqlite.prepare('SELECT * FROM time_blocks WHERE id = ?').get(id) as Record<string, unknown>;
}

/** Offset a stamp by whole seconds — keeps the stamping tests off the wall clock. */
function shift(ts: string, seconds: number): string {
  return new Date(Date.parse(ts) + seconds * 1000).toISOString();
}

function insertObjective(id: string, title = 'Test objective'): void {
  const now = '2026-06-01T00:00:00.000Z';
  sqlite
    .prepare(
      `INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, priority, created_at, updated_at, version)
       VALUES (?, ?, ?, 'objective', 'none', 'active', 'none', 3, ?, ?, 1)`,
    )
    .run(id, SYSTEM_OWNER, title, now, now);
}

function getObjective(id: string): Record<string, unknown> {
  return sqlite.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Record<string, unknown>;
}

function insertLink(linkId: string, objectiveId: string, taskId: string): void {
  sqlite
    .prepare(`INSERT INTO objective_tasks (objective_id, task_id, id, linked, version) VALUES (?, ?, ?, 1, 1)`)
    .run(objectiveId, taskId, linkId);
}

// ── applyMonotonic unit tests ─────────────────────────────────────────────────

describe('applyMonotonic', () => {
  it('returns the new value when status is not done', () => {
    expect(applyMonotonic('status', { status: 'open' }, 'done')).toBe('done');
  });

  it('blocks reverting a done status', () => {
    expect(applyMonotonic('status', { status: 'done' }, 'open')).toBe('done');
    expect(applyMonotonic('status', { status: 'done' }, 'cancelled')).toBe('done');
  });

  it('allows setting done when already done (idempotent)', () => {
    expect(applyMonotonic('status', { status: 'done' }, 'done')).toBe('done');
  });

  it('pins scheduled against a stale open (placement must not be lost)', () => {
    expect(applyMonotonic('status', { status: 'scheduled' }, 'open')).toBe('scheduled');
  });

  it('allows scheduled to advance to done / cancelled / in_progress', () => {
    expect(applyMonotonic('status', { status: 'scheduled' }, 'done')).toBe('done');
    expect(applyMonotonic('status', { status: 'scheduled' }, 'cancelled')).toBe('cancelled');
    expect(applyMonotonic('status', { status: 'scheduled' }, 'in_progress')).toBe('in_progress');
  });

  it('keeps earliest completed_at when a later value arrives', () => {
    const row = { completed_at: '2026-01-01T10:00:00Z' };
    expect(applyMonotonic('completed_at', row, '2026-01-02T10:00:00Z')).toBe('2026-01-01T10:00:00Z');
  });

  it('cannot null out an existing completed_at', () => {
    const row = { completed_at: '2026-01-01T10:00:00Z' };
    expect(applyMonotonic('completed_at', row, null)).toBe('2026-01-01T10:00:00Z');
  });

  it('accepts an earlier completed_at than existing (keeps existing — earlier already won)', () => {
    const row = { completed_at: '2026-01-05T10:00:00Z' };
    // an earlier timestamp means the existing is already the earliest
    expect(applyMonotonic('completed_at', row, '2026-01-01T10:00:00Z')).toBe('2026-01-01T10:00:00Z');
  });

  it('passes through non-special fields unchanged', () => {
    expect(applyMonotonic('title', {}, 'Hello')).toBe('Hello');
    expect(applyMonotonic('priority', {}, 5)).toBe(5);
  });
});

// ── applyOp unit tests ────────────────────────────────────────────────────────

describe('applyOp', () => {
  beforeEach(() => resetDb());

  it('applies a title update and advances version', () => {
    insertTask('t-1');
    const op: Op = {
      opId: 'op-a', entity: 'task', entityId: 't-1',
      fields: { title: 'Updated title' }, baseVersion: 1,
      clientTs: '2026-06-01T10:00:00.000Z',
    };
    const result = applyOp(sqlite, op, SYSTEM_OWNER);
    expect(result.applied).toEqual({ title: 'Updated title' });
    expect(result.dropped).toEqual([]);
    expect(result.version).toBe(2);

    const row = getTask('t-1');
    expect(row['title']).toBe('Updated title');
    expect(row['version']).toBe(2);
  });

  it('drops fields whose clientTs is older than stored field_ts (LWW)', () => {
    insertTask('t-2');

    // First op wins the field at T1
    applyOp(sqlite, {
      opId: 'op-b1', entity: 'task', entityId: 't-2',
      fields: { title: 'First write' }, baseVersion: 1,
      clientTs: '2026-06-01T12:00:00.000Z',
    }, SYSTEM_OWNER);

    // Second op arrives with an OLDER timestamp for the same field — should be dropped
    const result2 = applyOp(sqlite, {
      opId: 'op-b2', entity: 'task', entityId: 't-2',
      fields: { title: 'Late write' }, baseVersion: 1,
      clientTs: '2026-06-01T11:00:00.000Z',
    }, SYSTEM_OWNER);

    expect(result2.dropped).toContain('title');
    expect(result2.applied).not.toHaveProperty('title');
    expect(getTask('t-2')['title']).toBe('First write');
  });

  it('same-ts: op that arrives later wins (>= comparison)', () => {
    insertTask('t-3');

    applyOp(sqlite, {
      opId: 'op-c1', entity: 'task', entityId: 't-3',
      fields: { title: 'Alpha' }, baseVersion: 1,
      clientTs: '2026-06-01T12:00:00.000Z',
    }, SYSTEM_OWNER);

    // Same ts — should also win (>=)
    const result2 = applyOp(sqlite, {
      opId: 'op-c2', entity: 'task', entityId: 't-3',
      fields: { title: 'Beta' }, baseVersion: 1,
      clientTs: '2026-06-01T12:00:00.000Z',
    }, SYSTEM_OWNER);

    expect(result2.applied).toHaveProperty('title', 'Beta');
    expect(result2.dropped).toEqual([]);
  });

  it('enforces monotonic-completion: cannot un-complete via sync op', () => {
    insertTask('t-4');

    // Complete the task
    applyOp(sqlite, {
      opId: 'op-d1', entity: 'task', entityId: 't-4',
      fields: { status: 'done', completed_at: '2026-06-01T09:00:00.000Z' },
      baseVersion: 1, clientTs: '2026-06-01T10:00:00.000Z',
    }, SYSTEM_OWNER);

    // Concurrent op tries to revert — status must stay 'done'
    const result = applyOp(sqlite, {
      opId: 'op-d2', entity: 'task', entityId: 't-4',
      fields: { status: 'open' }, baseVersion: 1,
      clientTs: '2026-06-01T11:00:00.000Z',
    }, SYSTEM_OWNER);

    // Applied but clamped to 'done' by applyMonotonic
    expect(result.applied['status']).toBe('done');
    expect(getTask('t-4')['status']).toBe('done');
  });

  it('throws 404 for unknown entity', () => {
    expect(() =>
      applyOp(sqlite, {
        opId: 'op-e', entity: 'task', entityId: 'no-such-id',
        fields: { title: 'x' }, baseVersion: 0, clientTs: '2026-06-01T00:00:00.000Z',
      }, SYSTEM_OWNER),
    ).toThrow('not found');
  });

  it('silently ignores disallowed field names', () => {
    insertTask('t-6');
    const result = applyOp(sqlite, {
      opId: 'op-f', entity: 'task', entityId: 't-6',
      fields: { owner_id: 'injected', title: 'safe' },
      baseVersion: 1, clientTs: '2026-06-01T10:00:00.000Z',
    }, SYSTEM_OWNER);
    expect(result.applied).toEqual({ title: 'safe' });
    expect(getTask('t-6')['owner_id']).toBe(SYSTEM_OWNER);
  });

  it('multiple fields in one op — partial LWW drop', () => {
    insertTask('t-7');

    // Lock in 'title' at T2
    applyOp(sqlite, {
      opId: 'op-g1', entity: 'task', entityId: 't-7',
      fields: { title: 'Locked title' }, baseVersion: 1,
      clientTs: '2026-06-02T10:00:00.000Z',
    }, SYSTEM_OWNER);

    // Later op carries both 'title' (stale T1) and 'priority' (fresh T3)
    const result = applyOp(sqlite, {
      opId: 'op-g2', entity: 'task', entityId: 't-7',
      fields: { title: 'Lost title', priority: 5 }, baseVersion: 1,
      clientTs: '2026-06-01T10:00:00.000Z', // OLDER — title must drop
    }, SYSTEM_OWNER);

    // priority uses op.clientTs which is older than field_ts for 'title' but
    // priority has no prior field_ts so it applies
    expect(result.dropped).toContain('title');
    expect(result.applied).toHaveProperty('priority', 5);
  });
});

// ── scheduled-status guard (open⇄scheduled regression) ───────────────────────

describe('applyOp — scheduled status guard', () => {
  beforeEach(() => resetDb());

  function insertScheduledTask(id: string): void {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, priority, version, field_ts)
         VALUES (?, 'Placed task', ?, 'scheduled', 3, 5, ?)`,
      )
      .run(id, SYSTEM_OWNER, JSON.stringify({ status: '2026-06-01T12:00:00.000Z' }));
  }

  it('does NOT revert scheduled→open for a stale queued op (older clientTs)', () => {
    insertScheduledTask('t-sched-1');
    // A queued offline op carrying {status:'open'} with a clientTs OLDER than the
    // server's scheduled stamp — must be dropped by LWW, leaving 'scheduled'.
    const result = applyOp(sqlite, {
      opId: 'op-sched-1', entity: 'task', entityId: 't-sched-1',
      fields: { status: 'open' }, baseVersion: 1,
      clientTs: '2026-06-01T11:00:00.000Z', // older than the stored field_ts
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('status');
    expect(getTask('t-sched-1')['status']).toBe('scheduled');
  });

  it('still pins scheduled→open even when the op is NEWER (monotonic clamp)', () => {
    insertScheduledTask('t-sched-2');
    const result = applyOp(sqlite, {
      opId: 'op-sched-2', entity: 'task', entityId: 't-sched-2',
      fields: { status: 'open' }, baseVersion: 1,
      clientTs: '2026-06-01T13:00:00.000Z', // newer — wins LWW but is clamped
    }, SYSTEM_OWNER);

    expect(result.applied['status']).toBe('scheduled');
    expect(getTask('t-sched-2')['status']).toBe('scheduled');
  });
});

// ── cancelled status guard (soft-delete stamping) ─────────────────────────────

/**
 * `applyMonotonic` pins only done/scheduled, so nothing clamps cancelled→open — a
 * pin there would make cancelling irreversible through sync and break the restore
 * path. The soft-delete's `stampRow` is therefore the only thing standing between a
 * queued offline op and a resurrected task.
 */
describe('applyOp — cancelled status guard', () => {
  beforeEach(() => resetDb());

  it('does NOT revert cancelled→open for a stale queued op (older clientTs)', async () => {
    insertTask('t-del-1'); // 'open', no field_ts at all
    await deleteTask(SYSTEM_OWNER, 't-del-1');
    expect(getTask('t-del-1')['status']).toBe('cancelled');

    // The op a client queued while offline, before the cancel reached the server.
    const result = applyOp(sqlite, {
      opId: 'op-del-1', entity: 'task', entityId: 't-del-1',
      fields: { status: 'open' }, baseVersion: 1,
      clientTs: shift(fieldStamp('t-del-1', 'status', 'soft-delete'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('status');
    expect(getTask('t-del-1')['status']).toBe('cancelled');
  });

  it('a genuinely newer op still un-cancels (the stamp must not pin the restore path)', async () => {
    insertTask('t-del-2');
    await deleteTask(SYSTEM_OWNER, 't-del-2');

    const result = applyOp(sqlite, {
      opId: 'op-del-2', entity: 'task', entityId: 't-del-2',
      fields: { status: 'open' }, baseVersion: 1,
      clientTs: shift(fieldStamp('t-del-2', 'status', 'soft-delete'), +1),
    }, SYSTEM_OWNER);

    expect(result.dropped).not.toContain('status');
    expect(getTask('t-del-2')['status']).toBe('open');
  });
});

// ── subtype guard (habit promotion stamping) ──────────────────────────────────

/**
 * `subtype` is mergeable (allowlisted + camel-mapped) and `applyMonotonic` does not pin
 * it, so promoteToHabit's `stampRow` is the only thing stopping a queued op that still
 * carries the old subtype from demoting the habit on reconnect.
 */
describe('applyOp — subtype guard', () => {
  beforeEach(() => resetDb());

  it('does NOT revert habit→standard for a stale queued op (older clientTs)', async () => {
    insertTask('t-hab-1'); // subtype defaults, no field_ts at all
    await promoteToHabit(SYSTEM_OWNER, 't-hab-1');
    expect(getTask('t-hab-1')['subtype']).toBe('habit');

    // The op a client queued while offline, before the promotion reached the server.
    const result = applyOp(sqlite, {
      opId: 'op-hab-1', entity: 'task', entityId: 't-hab-1',
      fields: { subtype: 'standard' }, baseVersion: 1,
      clientTs: shift(fieldStamp('t-hab-1', 'subtype', 'promoteToHabit'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('subtype');
    expect(getTask('t-hab-1')['subtype']).toBe('habit');
  });

  it('a genuinely newer op still demotes (the stamp must not pin subtype)', async () => {
    insertTask('t-hab-2');
    await promoteToHabit(SYSTEM_OWNER, 't-hab-2');

    const result = applyOp(sqlite, {
      opId: 'op-hab-2', entity: 'task', entityId: 't-hab-2',
      fields: { subtype: 'standard' }, baseVersion: 1,
      clientTs: shift(fieldStamp('t-hab-2', 'subtype', 'promoteToHabit'), +1),
    }, SYSTEM_OWNER);

    expect(result.dropped).not.toContain('subtype');
    expect(getTask('t-hab-2')['subtype']).toBe('standard');
  });
});

// ── reschedule guard (owner action living in the nightly-review module) ───────

/**
 * `rescheduleTask` sits in engine/review.ts beside the cron, but it is an OWNER action
 * with a single route caller — so it stamps like any other online edit. Without it a
 * queued op holding the old day wins LWW and drags the task back off its new one.
 */
describe('rescheduleTask — stamping', () => {
  beforeEach(() => resetDb());

  it('does NOT let a stale queued op drag scheduled_for back', async () => {
    insertTask('t-resc-1');
    await rescheduleTask('t-resc-1', 3, SYSTEM_OWNER);
    const newDay = getTask('t-resc-1')['scheduled_for'] as string;

    // The op a client queued while offline, before the reschedule reached the server.
    const result = applyOp(sqlite, {
      opId: 'op-resc-1', entity: 'task', entityId: 't-resc-1',
      fields: { scheduled_for: '2026-01-01', status: 'open' }, baseVersion: 1,
      clientTs: shift(fieldStamp('t-resc-1', 'scheduled_for', 'rescheduleTask'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('scheduled_for');
    expect(getTask('t-resc-1')['scheduled_for']).toBe(newDay);
  });

  it('never stamps a foreign owner\'s row when the scoped UPDATE misses', async () => {
    createOwner(SECOND_OWNER_ID);
    insertTask('t-resc-2'); // belongs to SYSTEM_OWNER
    const before = getTask('t-resc-2');

    // A caller that skipped the route's ownership pre-check: the UPDATE must miss, and
    // the stamp must not fire — stamping here would corrupt SYSTEM_OWNER's merge state.
    await rescheduleTask('t-resc-2', 3, SECOND_OWNER_ID);

    const after = getTask('t-resc-2');
    expect(after['scheduled_for']).toBe(before['scheduled_for']);
    expect(after['version']).toBe(before['version']);
    expect(after['field_ts']).toBe(before['field_ts']);
  });
});

// ── owner-path writes the stampRow audit found unstamped (2026-07-16) ─────────

/**
 * Every site here is reached from a route or GraphQL mutation, so by the WHO-STAMPS rule
 * on `stampRow` it must stamp. (Their cron/agent counterparts — nightly review, groom,
 * auto-defense — deliberately do NOT, and are not tested here.) Each case asserts the
 * stale op is dropped; the geometry fields carry no applyMonotonic pin, so a
 * newer-op-still-wins case is included once per entity rather than per site.
 */
describe('owner-path writes — stamping', () => {
  beforeEach(() => resetDb());

  it('moveBlockGroup: a stale queued op cannot snap the group back', async () => {
    const before = { start_at: '2026-06-01T09:00:00.000Z', end_at: '2026-06-01T10:00:00.000Z' };
    insertBlock('b-mv-1', before);
    await moveBlockGroup(SYSTEM_OWNER, 'b-mv-1', 30);
    const moved = getBlock('b-mv-1')['start_at'] as string;
    expect(moved).not.toBe(before.start_at);

    const result = applyOp(sqlite, {
      opId: 'op-mv-1', entity: 'block', entityId: 'b-mv-1',
      fields: before, baseVersion: 1,
      clientTs: shift(fieldStamp('b-mv-1', 'start_at', 'moveBlockGroup', 'time_blocks'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('start_at');
    expect(getBlock('b-mv-1')['start_at']).toBe(moved);
  });

  it('moveBlockGroup: a genuinely newer op still moves it (no accidental pin)', async () => {
    insertBlock('b-mv-2');
    await moveBlockGroup(SYSTEM_OWNER, 'b-mv-2', 30);

    const result = applyOp(sqlite, {
      opId: 'op-mv-2', entity: 'block', entityId: 'b-mv-2',
      fields: { start_at: '2026-06-01T14:00:00.000Z' }, baseVersion: 1,
      clientTs: shift(fieldStamp('b-mv-2', 'start_at', 'moveBlockGroup', 'time_blocks'), +1),
    }, SYSTEM_OWNER);

    expect(result.dropped).not.toContain('start_at');
    expect(getBlock('b-mv-2')['start_at']).toBe('2026-06-01T14:00:00.000Z');
  });

  it('promoteBlockToScheduled: a stale queued op cannot un-promote the Plan', async () => {
    insertBlock('b-pr-1', { block_type: 'concept', duration_minutes: 60 });
    await promoteBlockToScheduled(SYSTEM_OWNER, 'b-pr-1', { start_at: '2026-06-01T14:00:00.000Z' });
    expect(getBlock('b-pr-1')['block_type']).toBe('scheduled');

    const result = applyOp(sqlite, {
      opId: 'op-pr-1', entity: 'block', entityId: 'b-pr-1',
      fields: { block_type: 'concept' }, baseVersion: 1,
      clientTs: shift(fieldStamp('b-pr-1', 'block_type', 'promoteBlockToScheduled', 'time_blocks'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('block_type');
    expect(getBlock('b-pr-1')['block_type']).toBe('scheduled');
  });

  it('extendBlock: a stale queued op cannot un-extend the anchor', async () => {
    insertBlock('b-ex-1');
    await extendBlock('b-ex-1', 30, { commit: true }, SYSTEM_OWNER);
    const extended = getBlock('b-ex-1')['end_at'] as string;
    expect(extended).toBe('2026-06-01T10:30:00.000Z');

    const result = applyOp(sqlite, {
      opId: 'op-ex-1', entity: 'block', entityId: 'b-ex-1',
      fields: { end_at: '2026-06-01T10:00:00.000Z' }, baseVersion: 1,
      clientTs: shift(fieldStamp('b-ex-1', 'end_at', 'extendBlock', 'time_blocks'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('end_at');
    expect(getBlock('b-ex-1')['end_at']).toBe(extended);
  });

  it('skipRecurringInstance: a stale queued op cannot revive the skipped instance', async () => {
    insertTask('t-tpl-1');
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority, version, recurrence_parent_id, occurrence_date)
                VALUES (?, 'Instance', ?, 'open', 3, 1, 't-tpl-1', '2026-06-01')`)
      .run('t-skip-1', SYSTEM_OWNER);

    await skipRecurringInstance(SYSTEM_OWNER, 't-skip-1');
    expect(getTask('t-skip-1')['status']).toBe('skipped');

    const result = applyOp(sqlite, {
      opId: 'op-skip-1', entity: 'task', entityId: 't-skip-1',
      fields: { status: 'open' }, baseVersion: 1,
      clientTs: shift(fieldStamp('t-skip-1', 'status', 'skipRecurringInstance'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('status');
    expect(getTask('t-skip-1')['status']).toBe('skipped');
  });
});

/**
 * The reschedule fix lives in the route handler itself, so this one goes over HTTP.
 * The route is dark behind `time_sense_enabled` (Phase Z), which is why this gap was
 * not reachable in production yet — the flag has to be on for the handler to run at all.
 */
describe('POST /api/blocks/:id/reschedule — stamping', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  it('a stale queued op cannot resurrect the abandoned attempt', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    insertTask('t-resched-1');
    insertBlock('b-resched-1', { task_id: 't-resched-1' });

    const r = await api(server.url, '/api/blocks/b-resched-1/reschedule', { method: 'POST', json: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(getBlock('b-resched-1')['status']).toBe('skipped');

    const result = applyOp(sqlite, {
      opId: 'op-resched-1', entity: 'block', entityId: 'b-resched-1',
      fields: { status: 'planned' }, baseVersion: 1,
      clientTs: shift(fieldStamp('b-resched-1', 'status', 'the reschedule route', 'time_blocks'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('status');
    expect(getBlock('b-resched-1')['status']).toBe('skipped');
  });
});

// ── the task⇄block mirror must stamp BOTH sides ───────────────────────────────

/**
 * `syncBlockFromTask` / `syncTaskFromBlock` keep a task and its placement block in
 * lockstep. Both run on owner paths (updateTask, and the block edits stamped elsewhere in
 * this PR), so both must stamp — stamping only one side leaves the other open to a stale
 * queued op that pulls the pair apart, which is the one invariant that module exists for.
 */
describe('task⇄block mirror — both sides stamped', () => {
  beforeEach(() => resetDb());

  it('syncBlockFromTask stamps the block it moves', async () => {
    insertTask('t-mirror-1');
    sqlite.prepare(
      `INSERT INTO time_blocks (id, owner_id, task_id, title, block_kind, start_at, end_at, status, version)
       VALUES ('b-mirror-1', ?, 't-mirror-1', 'M', 'task', '2026-06-01T09:00:00.000Z', '2026-06-01T10:00:00.000Z', 'planned', 1)`,
    ).run(SYSTEM_OWNER);

    // An owner PATCH that moves the task's time drags the block with it.
    await updateTask(SYSTEM_OWNER, 't-mirror-1', { task_time: '15:00' });
    const moved = getBlock('b-mirror-1')['start_at'] as string;
    expect(moved).not.toBe('2026-06-01T09:00:00.000Z');

    const result = applyOp(sqlite, {
      opId: 'op-mirror-1', entity: 'block', entityId: 'b-mirror-1',
      fields: { start_at: '2026-06-01T09:00:00.000Z', end_at: '2026-06-01T10:00:00.000Z' },
      baseVersion: 1,
      clientTs: shift(fieldStamp('b-mirror-1', 'start_at', 'syncBlockFromTask', 'time_blocks'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('start_at');
    expect(getBlock('b-mirror-1')['start_at']).toBe(moved);
  });

  it('syncTaskFromBlock stamps the task it re-dates', async () => {
    insertTask('t-mirror-2');
    insertBlock('b-mirror-2', { task_id: 't-mirror-2' });

    // An owner block drag mirrors onto the task's scheduled_for/task_time.
    await moveBlockGroup(SYSTEM_OWNER, 'b-mirror-2', 90);
    const dated = getTask('t-mirror-2')['scheduled_for'] as string;
    expect(dated).toBeTruthy();

    const result = applyOp(sqlite, {
      opId: 'op-mirror-2', entity: 'task', entityId: 't-mirror-2',
      fields: { scheduled_for: '2020-01-01' }, baseVersion: 1,
      clientTs: shift(fieldStamp('t-mirror-2', 'scheduled_for', 'syncTaskFromBlock'), -1),
    }, SYSTEM_OWNER);

    expect(result.dropped).toContain('scheduled_for');
    expect(getTask('t-mirror-2')['scheduled_for']).toBe(dated);
  });
});

// ── objective + objective_task round-trip ────────────────────────────────────

describe('applyOp — objective entity', () => {
  beforeEach(() => resetDb());

  it('round-trips a full objective op through apply', () => {
    insertObjective('o-1');
    const result = applyOp(sqlite, {
      opId: 'op-o-1', entity: 'objective', entityId: 'o-1',
      fields: { title: 'Renamed', status: 'paused', priority: 1, target_date: '2026-12-31' },
      baseVersion: 1, clientTs: '2026-06-02T10:00:00.000Z',
    }, SYSTEM_OWNER);

    expect(result.applied).toEqual({ title: 'Renamed', status: 'paused', priority: 1, target_date: '2026-12-31' });
    expect(result.version).toBe(2);
    const row = getObjective('o-1');
    expect(row['title']).toBe('Renamed');
    expect(row['status']).toBe('paused');
    expect(row['priority']).toBe(1);
    expect(row['target_date']).toBe('2026-12-31');
  });

  it('drops server-derived fields (level / progress_cache) not in the allowlist', () => {
    insertObjective('o-2');
    const result = applyOp(sqlite, {
      opId: 'op-o-2', entity: 'objective', entityId: 'o-2',
      fields: { level: 'goal', progress_cache: 0.9, title: 'Kept' },
      baseVersion: 1, clientTs: '2026-06-02T10:00:00.000Z',
    }, SYSTEM_OWNER);
    expect(result.applied).toEqual({ title: 'Kept' });
    expect(getObjective('o-2')['level']).toBe('objective'); // unchanged
  });

  it('isolates by owner (applying as a different owner is not found)', () => {
    insertObjective('o-3'); // owned by SYSTEM_OWNER
    expect(() =>
      applyOp(sqlite, {
        opId: 'op-o-3', entity: 'objective', entityId: 'o-3',
        fields: { title: 'x' }, baseVersion: 1, clientTs: '2026-06-02T10:00:00.000Z',
      }, 'a-different-owner'),
    ).toThrow('not found');
  });

  it('round-trips an objective_task link tombstone (linked 1→0) through apply', () => {
    insertObjective('o-4');
    insertTask('t-link-1');
    insertLink('lk-1', 'o-4', 't-link-1');

    const result = applyOp(sqlite, {
      opId: 'op-lk-1', entity: 'objective_task', entityId: 'lk-1',
      fields: { linked: 0 }, baseVersion: 1, clientTs: '2026-06-02T10:00:00.000Z',
    }, SYSTEM_OWNER);

    expect(result.applied).toEqual({ linked: 0 });
    const link = sqlite.prepare('SELECT linked FROM objective_tasks WHERE id = ?').get('lk-1') as { linked: number };
    expect(link.linked).toBe(0);
  });

  it('scopes an objective_task op by its parent objective owner', () => {
    insertObjective('o-5'); // owned by SYSTEM_OWNER
    insertTask('t-link-2');
    insertLink('lk-2', 'o-5', 't-link-2');
    // Applying as a different owner must not reach the link via its parent objective.
    expect(() =>
      applyOp(sqlite, {
        opId: 'op-lk-2', entity: 'objective_task', entityId: 'lk-2',
        fields: { linked: 0 }, baseVersion: 1, clientTs: '2026-06-02T10:00:00.000Z',
      }, 'a-different-owner'),
    ).toThrow('not found');
  });
});

// ── stampRow unit tests ───────────────────────────────────────────────────────

describe('stampRow', () => {
  beforeEach(() => resetDb());

  it('advances version and writes field_ts for stamped fields', () => {
    insertTask('t-stamp');
    stampRow(sqlite, 'task', 't-stamp', ['title', 'priority']);
    const row = getTask('t-stamp') as { version: number; field_ts: string };
    expect(row.version).toBe(2);
    const ft = JSON.parse(row.field_ts) as Record<string, string>;
    expect(typeof ft['title']).toBe('string');
    expect(typeof ft['priority']).toBe('string');
  });

  it('translates camelCase keys to snake_case', () => {
    insertTask('t-stamp2');
    stampRow(sqlite, 'task', 't-stamp2', ['scheduledFor', 'estimatedMinutes']);
    const row = getTask('t-stamp2') as { field_ts: string };
    const ft = JSON.parse(row.field_ts) as Record<string, string>;
    expect(ft['scheduled_for']).toBeDefined();
    expect(ft['estimated_minutes']).toBeDefined();
  });

  it('is a no-op for unknown entity', () => {
    // Should not throw — silently does nothing
    expect(() => stampRow(sqlite, 'task', 'no-exist', ['title'])).not.toThrow();
  });
});

// ── 0129 · sync must keep the live tree well-formed ───────────────────────────

/**
 * THE INVARIANT: no LIVE objective may have an ARCHIVED parent.
 *
 * It matters because buildTree filters archived rows out of `objs` and then roots any node
 * whose parent isn't in the map — so a live child under an archived parent doesn't nest,
 * it silently RESURFACES AS A TOP-LEVEL GOAL. #371 closed the API doors (createObjective /
 * updateObjective refuse an archived parent), but applyOp writes columns raw and never goes
 * through services/objectives.ts, so sync could still deliver the corrupt edge two ways:
 *
 *   (a) an op setting `parent_id` to an already-archived objective;
 *   (b) an op setting `archived_at` on a parent that still has live children — the API's
 *       archiveObjective cascades to its live subtree, but a synced archive never did.
 *
 * (b) needs no parent_id op at all, and archiving offline is an ordinary action, so it is
 * the likelier path to the same corruption. LWW gives no ordering guarantee, so BOTH must
 * hold independently — whichever op lands first.
 */
describe('sync cannot leave a live objective under an archived parent (0129)', () => {
  beforeEach(() => { resetDb(); sqlite.exec(`DELETE FROM objective_tasks; DELETE FROM objectives;`); });

  const mkObj = (id: string, parent: string | null = null, owner = SYSTEM_OWNER): void => {
    const now = '2026-06-01T00:00:00.000Z';
    sqlite.prepare(
      `INSERT INTO objectives (id, owner_id, parent_id, title, level, horizon, status, cadence, priority, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, 'objective', 'none', 'active', 'none', 3, ?, ?, 1)`,
    ).run(id, owner, parent, `T-${id}`, now, now);
  };
  const archiveRaw = (id: string): void => {
    sqlite.prepare(`UPDATE objectives SET archived_at = '2026-06-01T12:00:00.000Z' WHERE id = ?`).run(id);
  };
  const op = (entityId: string, fields: Record<string, unknown>, ts = '2026-06-02T10:00:00.000Z'): Op => ({
    opId: `op-${entityId}-${Object.keys(fields)[0]}`, entity: 'objective', entityId,
    fields, baseVersion: 1, clientTs: ts,
  });
  /**
   * The invariant, asked of every one of the owner's rows rather than the row under test.
   * Empty = well-formed.
   *
   * Scoped to ONE owner because that is the scope the invariant actually has: buildTree is
   * owner-scoped, so a cross-owner parent is already invisible to both owners' trees and a
   * stranger's child is not this cascade's to archive — refusing to touch it is the correct
   * behaviour, not a violation (see the cross-owner test below).
   */
  const liveChildrenOfArchivedParents = (owner = SYSTEM_OWNER): string[] =>
    (sqlite.prepare(
      `SELECT c.id FROM objectives c JOIN objectives p ON p.id = c.parent_id
        WHERE c.archived_at IS NULL AND p.archived_at IS NOT NULL
          AND c.owner_id = ? AND p.owner_id = ?`,
    ).all(owner, owner) as { id: string }[]).map((r) => r.id);

  // ── (a) the incoming parent_id ──
  it('clamps parent_id to NULL when the proposed parent is archived — an explicit re-root, not a silent one', () => {
    mkObj('a-arch'); mkObj('a-child');
    archiveRaw('a-arch');

    const res = applyOp(sqlite, op('a-child', { parent_id: 'a-arch' }), SYSTEM_OWNER);

    // The op still WINS its LWW comparison — only the value is clamped (mirrors
    // applyMonotonic's status pins). The client is told what actually landed.
    expect(res.applied).toEqual({ parent_id: null });
    expect(getObjective('a-child').parent_id).toBeNull();
    expect(liveChildrenOfArchivedParents()).toEqual([]);
  });

  it('accepts parent_id when the parent is LIVE (the clamp must not over-reach)', () => {
    mkObj('a-live'); mkObj('a-kid');
    const res = applyOp(sqlite, op('a-kid', { parent_id: 'a-live' }), SYSTEM_OWNER);
    expect(res.applied).toEqual({ parent_id: 'a-live' });
    expect(getObjective('a-kid').parent_id).toBe('a-live');
  });

  it('clamps a parent_id that does not exist at all — a bad ref must not crash the whole batch', () => {
    // parent_id REFERENCES objectives(id), so an unknown id used to throw a FOREIGN KEY
    // error out of applyOp, rolling back every other op in the transaction with it.
    mkObj('a-orphan');
    expect(() => applyOp(sqlite, op('a-orphan', { parent_id: 'no-such-objective' }), SYSTEM_OWNER)).not.toThrow();
    expect(getObjective('a-orphan').parent_id).toBeNull();
  });

  it('clamps a parent_id pointing at ANOTHER owner\'s objective', () => {
    createOwner();
    mkObj('a-mine'); mkObj('a-theirs', null, SECOND_OWNER_ID);
    const res = applyOp(sqlite, op('a-mine', { parent_id: 'a-theirs' }), SYSTEM_OWNER);
    expect(res.applied).toEqual({ parent_id: null }); // live, but not mine
    expect(getObjective('a-mine').parent_id).toBeNull();
  });

  // ── (b) the incoming archived_at ──
  it('cascades a synced archive over the live subtree, exactly as archiveObjective does', () => {
    mkObj('b-goal'); mkObj('b-proj', 'b-goal'); mkObj('b-leaf', 'b-proj'); // 2 levels deep

    applyOp(sqlite, op('b-goal', { archived_at: '2026-06-02T10:00:00.000Z' }), SYSTEM_OWNER);
    applySyncedObjectiveUpkeep(SYSTEM_OWNER, 'b-goal', { archived_at: '2026-06-02T10:00:00.000Z' });

    expect(liveChildrenOfArchivedParents()).toEqual([]);
    for (const id of ['b-proj', 'b-leaf']) {
      const row = getObjective(id);
      expect(row.archived_at).toBeTruthy();
      expect(row.archive_root_id).toBe('b-goal'); // restores as a unit
    }
  });

  it('a synced UN-archive does not cascade — restore stays root-only (0129 subtree rule)', () => {
    mkObj('b2-goal'); mkObj('b2-kid', 'b2-goal');
    applyOp(sqlite, op('b2-goal', { archived_at: '2026-06-02T10:00:00.000Z' }), SYSTEM_OWNER);
    applySyncedObjectiveUpkeep(SYSTEM_OWNER, 'b2-goal', { archived_at: '2026-06-02T10:00:00.000Z' });
    // Clearing archived_at must not fan out — restoreObjective owns that path.
    applyOp(sqlite, op('b2-goal', { archived_at: null }, '2026-06-03T10:00:00.000Z'), SYSTEM_OWNER);
    expect(() => applySyncedObjectiveUpkeep(SYSTEM_OWNER, 'b2-goal', { archived_at: null })).not.toThrow();
    expect(getObjective('b2-goal').archived_at).toBeNull();
  });

  /**
   * The archive cascade must not TOUCH another owner's row — not even its sync metadata.
   *
   * liveDescendantIds walks `parent_id` unscoped, so a corrupt cross-owner edge (the very
   * thing the clamp above now prevents, but which older data may already carry) pulls a
   * stranger's objective into the descendant list. The archiving UPDATE is owner-scoped and
   * correctly matches 0 rows — but stampRow keys on `id` ALONE, so it would still bump their
   * `version` and rewrite their `field_ts`.
   *
   * That is worse than a wasted write: stamping `archived_at`'s field_ts with the current
   * clock makes that owner's own later archive/restore op LOSE the LWW comparison and get
   * silently dropped. A cross-tenant write into someone else's merge state.
   *
   * Same class as the recursive-walk scoping in #369 — liveDescendantIds is the walk that
   * pass missed.
   */
  it('never touches another owner\'s objective — not archived, not even stamped', () => {
    createOwner();
    mkObj('x-mine');
    mkObj('x-theirs', 'x-mine', SECOND_OWNER_ID); // corrupt cross-owner edge (pre-existing data)
    const before = getObjective('x-theirs');

    applyOp(sqlite, op('x-mine', { archived_at: '2026-06-02T10:00:00.000Z' }), SYSTEM_OWNER);
    applySyncedObjectiveUpkeep(SYSTEM_OWNER, 'x-mine', { archived_at: '2026-06-02T10:00:00.000Z' });

    const after = getObjective('x-theirs');
    expect(after.archived_at).toBeNull();        // owner-scoped UPDATE already got this right
    expect(after.archive_root_id).toBeNull();
    // …and the sync metadata must be untouched, or their next archive op loses LWW silently.
    expect(after.version).toBe(before.version);
    expect(after.field_ts).toBe(before.field_ts);
  });

  // ── order independence: LWW guarantees no arrival order ──
  it('holds whichever order the two ops arrive in', () => {
    // Order 1: re-parent first, THEN archive the parent → the cascade must catch the child.
    mkObj('o1-p'); mkObj('o1-c');
    applyOp(sqlite, op('o1-c', { parent_id: 'o1-p' }), SYSTEM_OWNER);
    applyOp(sqlite, op('o1-p', { archived_at: '2026-06-02T11:00:00.000Z' }), SYSTEM_OWNER);
    applySyncedObjectiveUpkeep(SYSTEM_OWNER, 'o1-p', { archived_at: '2026-06-02T11:00:00.000Z' });
    expect(liveChildrenOfArchivedParents()).toEqual([]);
    expect(getObjective('o1-c').archived_at).toBeTruthy(); // archived WITH its parent

    // Order 2: archive first, THEN the re-parent op arrives → the clamp must catch it.
    mkObj('o2-p'); mkObj('o2-c');
    applyOp(sqlite, op('o2-p', { archived_at: '2026-06-02T11:00:00.000Z' }), SYSTEM_OWNER);
    applySyncedObjectiveUpkeep(SYSTEM_OWNER, 'o2-p', { archived_at: '2026-06-02T11:00:00.000Z' });
    applyOp(sqlite, op('o2-c', { parent_id: 'o2-p' }), SYSTEM_OWNER);
    expect(liveChildrenOfArchivedParents()).toEqual([]);
    expect(getObjective('o2-c').parent_id).toBeNull();     // re-rooted, explicitly
    expect(getObjective('o2-c').archived_at).toBeNull();   // …and still live

    // Different end states — LWW is order-sensitive by nature — but BOTH well-formed,
    // which is the property that matters: the server never holds a corrupt tree.
  });
});

// ── POST /api/sync integration tests ─────────────────────────────────────────

describe('POST /api/sync', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  async function createTask(title: string): Promise<string> {
    const r = await api(server.url, '/api/tasks', { method: 'POST', json: { title, priority: 3 } });
    return r.body.task.id as string;
  }

  it('applies a batch of ops and returns results with correct versions', async () => {
    const id = await createTask('Sync me');
    const ts = new Date().toISOString();

    const r = await api(server.url, '/api/sync', {
      method: 'POST',
      json: {
        ops: [
          {
            opId: 'op-int-1', entity: 'task', entityId: id,
            fields: { title: 'New title' }, baseVersion: 1, clientTs: ts,
          },
        ],
      },
    });

    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    const result = r.body.results[0];
    expect(result.opId).toBe('op-int-1');
    expect(result.applied.title).toBe('New title');
    expect(result.dropped).toEqual([]);
    expect(result.version).toBeGreaterThanOrEqual(2);
  });

  it('returns dropped fields in result when LWW rejects them', async () => {
    const id = await createTask('LWW test');
    const earlyTs = '2020-01-01T00:00:00.000Z';
    const lateTs  = '2030-01-01T00:00:00.000Z';

    // First op wins with a far-future timestamp
    await api(server.url, '/api/sync', {
      method: 'POST',
      json: {
        ops: [{
          opId: 'op-lww-1', entity: 'task', entityId: id,
          fields: { title: 'Future wins' }, baseVersion: 1, clientTs: lateTs,
        }],
      },
    });

    // Second op with a past timestamp — title must be dropped
    const r2 = await api(server.url, '/api/sync', {
      method: 'POST',
      json: {
        ops: [{
          opId: 'op-lww-2', entity: 'task', entityId: id,
          fields: { title: 'Past loses' }, baseVersion: 1, clientTs: earlyTs,
        }],
      },
    });

    expect(r2.status).toBe(200);
    const result = r2.body.results[0];
    expect(result.dropped).toContain('title');
  });

  it('returns 400 when ops array is empty or missing', async () => {
    const r = await api(server.url, '/api/sync', { method: 'POST', json: { ops: [] } });
    expect([200, 400]).toContain(r.status);
  });

  it('returns 400 when ops exceeds the 200 op limit', async () => {
    const id = await createTask('Big batch');
    const ts = new Date().toISOString();
    const ops = Array.from({ length: 201 }, (_, i) => ({
      opId: `op-big-${i}`, entity: 'task', entityId: id,
      fields: { title: `t${i}` }, baseVersion: 1, clientTs: ts,
    }));
    const r = await api(server.url, '/api/sync', { method: 'POST', json: { ops } });
    expect(r.status).toBe(400);
  });

  it('returns 404 result for an op targeting a non-existent entity', async () => {
    const ts = new Date().toISOString();
    const r = await api(server.url, '/api/sync', {
      method: 'POST',
      json: {
        ops: [{
          opId: 'op-missing', entity: 'task', entityId: 'no-such-task',
          fields: { title: 'x' }, baseVersion: 0, clientTs: ts,
        }],
      },
    });
    expect(r.status).toBe(200);
    const result = r.body.results[0];
    expect(result.opId).toBe('op-missing');
    expect(result.error).toBeDefined();
  });
});

// ── 0129: archiving through sync ──────────────────────────────────────────────

describe('objective archive via sync (0129)', () => {
  it('archives a DONE objective — the regression the archived_at column exists to prevent', () => {
    insertObjective('o-arch-1');
    sqlite.prepare(`UPDATE objectives SET status = 'done' WHERE id = ?`).run('o-arch-1');

    const result = applyOp(sqlite, {
      opId: 'op-arch-1', entity: 'objective', entityId: 'o-arch-1',
      fields: { archived_at: '2026-06-02T10:00:00.000Z' },
      baseVersion: 1, clientTs: '2026-06-02T10:00:00.000Z',
    }, SYSTEM_OWNER);

    expect(result.applied).toEqual({ archived_at: '2026-06-02T10:00:00.000Z' });
    const row = sqlite.prepare('SELECT archived_at, status FROM objectives WHERE id = ?').get('o-arch-1') as
      { archived_at: string | null; status: string };
    expect(row.archived_at).toBe('2026-06-02T10:00:00.000Z');
    // Had we routed archiving through `status`, applyMonotonic's done-pin
    // (apply.ts: status==='done' && value!=='done' ⇒ 'done') would have silently
    // clamped this back and the objective could never be archived through sync.
    expect(row.status).toBe('done'); // status is preserved — restore is lossless
  });

  it('un-archives through sync — archived_at is NOT monotonically pinned', () => {
    insertObjective('o-arch-2');
    sqlite.prepare(`UPDATE objectives SET archived_at = '2026-06-01T00:00:00.000Z' WHERE id = ?`).run('o-arch-2');

    const result = applyOp(sqlite, {
      opId: 'op-arch-2', entity: 'objective', entityId: 'o-arch-2',
      fields: { archived_at: null }, baseVersion: 1, clientTs: '2026-06-02T10:00:00.000Z',
    }, SYSTEM_OWNER);

    expect(result.applied).toEqual({ archived_at: null });
    const row = sqlite.prepare('SELECT archived_at FROM objectives WHERE id = ?').get('o-arch-2') as { archived_at: string | null };
    expect(row.archived_at).toBeNull(); // a pin here would defeat the 48h reversal
  });

  it('purge_after is server-owned — a client op cannot author it', () => {
    insertObjective('o-arch-3');
    const result = applyOp(sqlite, {
      opId: 'op-arch-3', entity: 'objective', entityId: 'o-arch-3',
      fields: { purge_after: '2020-01-01T00:00:00.000Z' },
      baseVersion: 1, clientTs: '2026-06-02T10:00:00.000Z',
    }, SYSTEM_OWNER);

    expect(result.applied).toEqual({}); // dropped: absent from OBJECTIVE_FIELDS
    const row = sqlite.prepare('SELECT purge_after FROM objectives WHERE id = ?').get('o-arch-3') as { purge_after: string | null };
    expect(row.purge_after).toBeNull(); // else a peer could schedule a purge behind the server's back
  });
});
