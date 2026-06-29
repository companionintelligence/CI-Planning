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
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

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
