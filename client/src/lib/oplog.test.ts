/**
 * Phase L: unit tests for lib/oplog.ts using an injectable in-memory store.
 * No IndexedDB required — tests run in the Node environment via vitest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  enqueue, pending, ack, markInflight, requeueInflight,
  _setTestStore,
  type Op, type OpStorage,
} from './oplog.js';

// ── In-memory OpStorage ───────────────────────────────────────────────────────

function memStore(): OpStorage {
  const map = new Map<string, Op>();
  return {
    put: async (op) => { map.set(op.opId, op); },
    getAll: async () => Array.from(map.values()),
    delete: async (opId) => { map.delete(opId); },
  };
}

function makeOp(opId: string, extra: Partial<Omit<Op, 'opId' | 'status'>> = {}): Omit<Op, 'status'> {
  return {
    opId,
    entity: 'task',
    entityId: 'task-1',
    fields: { title: `Title for ${opId}` },
    baseVersion: 1,
    clientTs: `2026-06-0${opId.slice(-1) || '1'}T10:00:00.000Z`,
    ...extra,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('oplog', () => {
  beforeEach(() => _setTestStore(memStore()));
  afterEach(() => _setTestStore(null));

  it('enqueue writes an op with status=pending', async () => {
    await enqueue(makeOp('op-1'));
    const ops = await pending();
    expect(ops).toHaveLength(1);
    expect(ops[0].opId).toBe('op-1');
    expect(ops[0].status).toBe('pending');
  });

  it('pending returns only status=pending ops, sorted by opId', async () => {
    // Insert in reverse lexicographic order
    await enqueue(makeOp('op-c'));
    await enqueue(makeOp('op-a'));
    await enqueue(makeOp('op-b'));

    const ops = await pending();
    expect(ops.map((o) => o.opId)).toEqual(['op-a', 'op-b', 'op-c']);
  });

  it('ack removes the op so it no longer appears in pending', async () => {
    await enqueue(makeOp('op-del'));
    await ack('op-del');
    const ops = await pending();
    expect(ops.find((o) => o.opId === 'op-del')).toBeUndefined();
  });

  it('markInflight transitions pending → inflight; inflight ops are absent from pending()', async () => {
    await enqueue(makeOp('op-fly'));
    await markInflight(['op-fly']);
    const ops = await pending();
    expect(ops.find((o) => o.opId === 'op-fly')).toBeUndefined();
  });

  it('requeueInflight resets inflight ops back to pending', async () => {
    await enqueue(makeOp('op-crash'));
    await markInflight(['op-crash']);
    // Simulate a crash / failed flush — requeue
    await requeueInflight();
    const ops = await pending();
    expect(ops.find((o) => o.opId === 'op-crash')?.status).toBe('pending');
  });

  it('markInflight is a no-op for already-inflight ops', async () => {
    await enqueue(makeOp('op-dbl'));
    await markInflight(['op-dbl']);
    // Second markInflight call should not throw and result should still be inflight
    await markInflight(['op-dbl']);
    const ops = await pending();
    expect(ops.find((o) => o.opId === 'op-dbl')).toBeUndefined();
  });

  it('requeueInflight does not touch pending ops', async () => {
    await enqueue(makeOp('op-still-pending'));
    await requeueInflight(); // no inflight ops — should leave pending alone
    const ops = await pending();
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe('pending');
  });

  it('ack on a non-existent opId does not throw', async () => {
    await expect(ack('ghost-op')).resolves.toBeUndefined();
  });

  it('full lifecycle: enqueue → markInflight → ack', async () => {
    await enqueue(makeOp('op-life'));
    expect(await pending()).toHaveLength(1);

    await markInflight(['op-life']);
    expect(await pending()).toHaveLength(0);

    await ack('op-life');
    // Also not in the store at all
    const all = await pending(); // after ack there's nothing
    expect(all.find((o) => o.opId === 'op-life')).toBeUndefined();
  });

  it('enqueue multiple ops for different entities', async () => {
    await enqueue({ opId: 'op-t', entity: 'task',  entityId: 'task-1', fields: { title: 'T' }, baseVersion: 1, clientTs: '2026-06-01T10:00:00Z' });
    await enqueue({ opId: 'op-b', entity: 'block', entityId: 'blk-1',  fields: { title: 'B' }, baseVersion: 2, clientTs: '2026-06-01T10:00:01Z' });

    const ops = await pending();
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.entity).sort()).toEqual(['block', 'task']);
  });
});
