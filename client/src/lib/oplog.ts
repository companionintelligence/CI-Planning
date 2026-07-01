/**
 * Phase L: durable client-side op-log backed by IndexedDB.
 *
 * Every mutation is written here BEFORE hitting the network. The op is
 * deleted only after the server acks it via POST /api/sync.  On reconnect
 * `flush()` (in stores/mutations.ts) drains the queue oldest-first.
 *
 * The injectable OpStorage interface lets tests swap in an in-memory Map
 * without needing a real IndexedDB implementation.
 */

/** Entities that participate in the Phase L op-log / sync layer. */
export type SyncEntity = 'task' | 'block' | 'objective' | 'objective_task';

export interface Op {
  /** uuidv7 — monotonic, client-generated; doubles as the idempotency key. */
  opId: string;
  entity: SyncEntity;
  entityId: string;
  /** Snake_case, API-shape field names (only changed fields, not a snapshot). */
  fields: Record<string, unknown>;
  /** entity.version the client last saw (0 if unknown / offline-create). */
  baseVersion: number;
  /** UTC ISO, device clock — tiebreak only, never authoritative. */
  clientTs: string;
  status: 'pending' | 'inflight' | 'acked';
}

// ── Injectable store (test hook) ─────────────────────────────────────────────

export interface OpStorage {
  put(op: Op): Promise<void>;
  getAll(): Promise<Op[]>;
  delete(opId: string): Promise<void>;
}

let _testStore: OpStorage | null = null;

/** Swap in an in-memory store for tests. Pass `null` to restore IndexedDB. */
export function _setTestStore(store: OpStorage | null): void {
  _testStore = store;
  _idbStore  = null; // force re-init when restoring real IDB
}

// ── IndexedDB implementation ──────────────────────────────────────────────────

const DB_NAME   = 'companion-oplog';
const STORE_KEY = 'ops';
const IDB_VER   = 1;

let _idb: IDBDatabase | null = null;

async function openIdb(): Promise<IDBDatabase> {
  if (_idb) return _idb;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, IDB_VER);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_KEY)) {
        req.result.createObjectStore(STORE_KEY, { keyPath: 'opId' });
      }
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb!); };
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, op: Op): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_KEY, 'readwrite').objectStore(STORE_KEY).put(op);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function idbGetAll(db: IDBDatabase): Promise<Op[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_KEY, 'readonly').objectStore(STORE_KEY).getAll();
    req.onsuccess = () => resolve(req.result as Op[]);
    req.onerror   = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, opId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_KEY, 'readwrite').objectStore(STORE_KEY).delete(opId);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function makeIdbStore(): OpStorage {
  return {
    async put(op)        { await idbPut(await openIdb(), op); },
    async getAll()       { return idbGetAll(await openIdb()); },
    async delete(opId)   { await idbDelete(await openIdb(), opId); },
  };
}

let _idbStore: OpStorage | null = null;

function store(): OpStorage {
  if (_testStore) return _testStore;
  if (!_idbStore) _idbStore = makeIdbStore();
  return _idbStore;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Write op to the outbox with status='pending'. */
export async function enqueue(op: Omit<Op, 'status'>): Promise<void> {
  await store().put({ ...op, status: 'pending' });
}

/** All ops with status='pending', ordered by opId (uuidv7 → causal-ish). */
export async function pending(): Promise<Op[]> {
  const all = await store().getAll();
  return all
    .filter((o) => o.status === 'pending')
    .sort((a, b) => a.opId.localeCompare(b.opId));
}

/** Remove an op after the server has acked it. */
export async function ack(opId: string): Promise<void> {
  await store().delete(opId);
}

/** Transition ops from 'pending' → 'inflight' while a flush is in flight. */
export async function markInflight(opIds: string[]): Promise<void> {
  if (opIds.length === 0) return;
  const all = await store().getAll();
  for (const op of all) {
    if (opIds.includes(op.opId) && op.status === 'pending') {
      await store().put({ ...op, status: 'inflight' });
    }
  }
}

/**
 * Reset all 'inflight' ops back to 'pending'.
 * Called on module load (crash recovery) and on network error (failed flush).
 */
export async function requeueInflight(): Promise<void> {
  const all = await store().getAll();
  for (const op of all) {
    if (op.status === 'inflight') {
      await store().put({ ...op, status: 'pending' });
    }
  }
}
