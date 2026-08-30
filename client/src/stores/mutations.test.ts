/**
 * Regression coverage for the op-log flush loop (stores/mutations.ts).
 *
 * Three defects motivated this file, all in the failure paths — the happy path
 * always worked, which is why none of them surfaced:
 *
 *  1. `flush()` re-kicked itself from its own `finally` the instant a flush
 *     failed, so an offline client retried POST /api/sync in a tight loop
 *     (measured: ~280 attempts in 300ms for ONE queued edit). With a
 *     synchronous failure the recursion never yielded to the macrotask queue
 *     at all and starved the event loop.
 *  2. `pending()` returns the WHOLE queue and flush sent it unchunked, but the
 *     server caps a batch at 200 (routes/sync.ts BATCH_LIMIT). Past 200 queued
 *     ops every flush 400'd, which fed (1) — a permanent, unrecoverable spin
 *     in which the user's edits could never sync.
 *  3. The server answers `{ results: [...] }`; the client typed and consumed it
 *     as a bare array, so `for (const r of results)` threw before any op was
 *     acked. Ops were left 'inflight' forever and the queue only ever grew.
 *
 * The mocks below deliberately speak the REAL server response shape — mocking
 * the (wrong) declared type is what let defect 3 hide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _setTestStore, type Op, type OpStorage } from '../lib/oplog.js';

vi.mock('./index.js', () => ({
  mutateTasks: () => {}, mutateBlocks: () => {}, tasks: () => [], blocks: () => [],
}));
vi.mock('../lib/sse.js', () => ({ registerFlushHook: () => {} }));

/** Server behaviour for the next POST /api/sync, driven per-test. */
const server = {
  calls: [] as number[],          // ops-per-request, in order
  mode: 'ok' as 'ok' | 'offline' | 'reject-op',
  batchLimit: 200,
};

vi.mock('../lib/api.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js');
  return {
    ...actual,
    api: {
      sync: {
        apply: async (ops: { opId: string }[]) => {
          server.calls.push(ops.length);
          // A real fetch yields to the macrotask queue; model that so timers run.
          await new Promise((r) => setTimeout(r, 0));
          if (server.mode === 'offline') throw new actual.ApiError('Failed to fetch', 0);
          if (ops.length > server.batchLimit) {
            throw new actual.ApiError(`batch too large (max ${server.batchLimit})`, 400);
          }
          if (server.mode === 'reject-op') {
            return ops.map((o) => ({ opId: o.opId, error: 'validation failed' }));
          }
          return ops.map((o) => ({
            opId: o.opId, entityId: 'e1', version: 1, applied: {}, dropped: [],
          }));
        },
      },
    },
  };
});

function memStore(): OpStorage & { rows: Map<string, Op> } {
  const rows = new Map<string, Op>();
  return {
    rows,
    async put(op) { rows.set(op.opId, op); },
    async getAll() { return [...rows.values()]; },
    async delete(id) { rows.delete(id); },
  };
}

let store: ReturnType<typeof memStore>;

async function load() {
  return import('./mutations.js');
}

async function seed(n: number): Promise<void> {
  const { enqueue } = await import('../lib/oplog.js');
  for (let i = 0; i < n; i++) {
    await enqueue({
      opId: `op-${String(i).padStart(4, '0')}`,
      entity: 'task',
      entityId: `t${i}`,
      fields: { title: `edit ${i}` },
      baseVersion: 0,
      clientTs: new Date().toISOString(),
    });
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('op-log flush', () => {
  beforeEach(async () => {
    store = memStore();
    _setTestStore(store);
    server.calls = [];
    server.mode = 'ok';
    server.batchLimit = 200;
    const { __resetFlushState } = await load();
    __resetFlushState();
    const { resolveAllConflicts } = await import('./conflicts.js');
    resolveAllConflicts();
  });

  afterEach(() => { _setTestStore(null); });

  it('acks a successful op and empties the outbox', async () => {
    const { flush } = await load();
    await seed(1);
    await flush();
    expect(store.rows.size).toBe(0);
    expect(server.calls).toEqual([1]);
  });

  it('chunks a queue larger than the server batch limit', async () => {
    const { flush } = await load();
    await seed(450);
    await flush();
    expect(server.calls).toEqual([200, 200, 50]);
    expect(store.rows.size).toBe(0);
  });

  it('does not spin when the network is down', async () => {
    const { flush } = await load();
    server.mode = 'offline';
    await seed(1);
    await flush();
    await tick(200); // inside the 250ms first backoff
    // One attempt, then a timer — not a hot loop. (Before the fix this same
    // window produced ~190 attempts for this one op.)
    expect(server.calls.length).toBe(1);
    // The op survives for the next attempt rather than being dropped.
    expect(store.rows.size).toBe(1);
    expect([...store.rows.values()][0].status).toBe('pending');
  });

  it('retries on a backoff after a failure instead of immediately', async () => {
    const { flush } = await load();
    server.mode = 'offline';
    await seed(1);
    await flush();
    await tick(60);
    expect(server.calls.length).toBe(1); // backoff has not elapsed yet
    server.mode = 'ok';
    await tick(400);                     // first backoff is 250ms
    expect(server.calls.length).toBeGreaterThan(1);
    expect(store.rows.size).toBe(0);     // and it drained once the network returned
  });

  it('keeps a server-rejected op out of the outbox but surfaces it to the user', async () => {
    const { flush } = await load();
    const { conflicts } = await import('./conflicts.js');
    server.mode = 'reject-op';
    await seed(1);
    await flush();
    // The op is not retried forever (the server rejected it deterministically)…
    expect(store.rows.size).toBe(0);
    // …but the edit does not vanish silently: the user is told, and can re-apply.
    expect(conflicts()).toHaveLength(1);
    expect(conflicts()[0].kind).toBe('rejected');
    expect(conflicts()[0].fields).toEqual(['title']);
  });

  it('re-queues a rejected edit when the user chooses to keep it', async () => {
    const { flush } = await load();
    const { conflicts } = await import('./conflicts.js');
    server.mode = 'reject-op';
    await seed(1);
    await flush();

    // Go offline first so the re-queued op stays observable in the outbox instead
    // of being re-sent and rejected again by the still-refusing mock.
    server.mode = 'offline';
    conflicts()[0].recover();
    await tick(50);
    expect(store.rows.size).toBe(1);
    expect([...store.rows.values()][0].fields).toEqual({ title: 'edit 0' });
  });
});
