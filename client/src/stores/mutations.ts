/**
 * Phase L: optimistic mutation helpers + op-log flush.
 *
 * Every public function here:
 *  1. Applies the change locally (optimistic update via SolidJS resource mutate)
 *  2. Enqueues a field-scoped Op in IndexedDB
 *  3. Kicks off flush() (best-effort; no-op while offline)
 *
 * flush() drains the queue oldest-first via POST /api/sync, in batches the server
 * will accept (SYNC_BATCH_LIMIT). On failure the ops stay 'pending' and the next
 * attempt is paced by an exponential backoff — plus the existing kicks from the
 * online event, an SSE reconnect, and a Service-Worker push.
 *
 * Two rules hold this together, and both were learned the hard way:
 *  - Nothing re-enters flush() on a failure except `scheduleRetry`. Anything else
 *    is a hot loop, because "failure" and "there is still work queued" are the
 *    same condition.
 *  - An op only leaves the outbox once the server has given a verdict on it.
 *    Dropping one for any other reason silently destroys a user's edit that the
 *    optimistic update is still displaying.
 */

import { enqueue, pending, ack, markInflight, requeueInflight, type Op } from '../lib/oplog.js';
import { api, ApiError, type SyncOp, type SyncResult, type SyncError } from '../lib/api.js';
import { registerFlushHook } from '../lib/sse.js';
import { mutateTasks, mutateBlocks, tasks, blocks } from './index.js';
import { addConflict, type ConflictKind } from './conflicts.js';
import type { Task, Block } from '../lib/api.js';

// On module load, recover any ops left inflight by a previous session (crash / hard reload).
void requeueInflight();

let flushing = false;

/**
 * Ops per POST /api/sync. MUST NOT exceed the server's BATCH_LIMIT
 * (server/src/routes/sync.ts) — it 400s the whole request past that, and a 400 is
 * indistinguishable here from any other failed flush. Sending the queue unchunked
 * meant that once an offline session banked 201 edits, every flush 400'd forever
 * and none of those edits could ever sync.
 */
const SYNC_BATCH_LIMIT = 200;

/** Retry schedule for a FAILED flush: 250ms doubling to 30s. */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS  = 30_000;

let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelayMs = RETRY_BASE_MS;

/**
 * Arm the one retry timer, doubling the delay each consecutive failure.
 *
 * The whole point is that nothing anywhere may re-enter `flush()` on a failure
 * without going through here. The original code re-kicked from flush's own
 * `finally` the moment a flush failed, which turned "offline" into ~280 requests
 * per 300ms for a single queued edit — and, when the failure resolved
 * synchronously, into an unbroken microtask chain that starved the event loop so
 * no timer in the tab could fire at all.
 */
function scheduleRetry(): void {
  if (retryTimer !== undefined) return; // a retry is already armed
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void flush();
  }, delay);
}

/** Disarm the retry and reset the backoff — called on any successful round trip. */
function clearRetry(): void {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  retryDelayMs = RETRY_BASE_MS;
}

/**
 * Test hook: drop any armed retry and clear the re-entrancy latch between cases.
 *
 * `flushing` needs resetting too — a case that ends while a retry is mid-request
 * leaves the latch set, and the next case's `flush()` would return without doing
 * anything, which reads as a broken flush rather than as leaked state.
 */
export function __resetFlushState(): void {
  clearRetry();
  flushing = false;
}

// ── uuidv7 ────────────────────────────────────────────────────────────────────

function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = Date.now();
  // Embed 48-bit timestamp
  bytes[0] = (ms / 0x10000000000) & 0xff;
  bytes[1] = (ms / 0x100000000)   & 0xff;
  bytes[2] = (ms / 0x1000000)     & 0xff;
  bytes[3] = (ms / 0x10000)       & 0xff;
  bytes[4] = (ms / 0x100)         & 0xff;
  bytes[5] =  ms                  & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function nowUTC(): string {
  return new Date().toISOString();
}

// ── Conflict surfacing (§6) ────────────────────────────────────────────────────

/**
 * Tell the owner an edit of theirs did not stick, with a one-click re-apply.
 *
 * `fields` is the subset of `originalOp.fields` at issue — the LWW losers for an
 * 'overwritten' conflict, all of them for a 'rejected' one.
 */
function surfaceConflict(originalOp: Op, fields: string[], kind: ConflictKind): void {
  const lostFields: Record<string, unknown> = Object.fromEntries(
    fields.map((f) => [f, originalOp.fields[f]]),
  );

  const entityTitle =
    originalOp.entity === 'task'
      ? (tasks() ?? []).find((t) => t.id === originalOp.entityId)?.title ?? 'task'
      : originalOp.entity === 'block'
      ? (blocks() ?? []).find((b) => b.id === originalOp.entityId)?.title ?? 'block'
      : originalOp.entity === 'objective'
      ? 'objective'
      : 'objective link';

  addConflict({
    id:          uuidv7(),
    entity:      originalOp.entity,
    entityId:    originalOp.entityId,
    entityTitle,
    fields,
    kind,
    recover: () => {
      // The enqueue is AWAITED before the flush: floating both raced the write
      // against the read, and a flush that ran first found an empty queue. That used
      // to self-heal because flush re-kicked itself from its `finally`, which is
      // exactly the loop this file no longer has — so the ordering is explicit now.
      void (async () => {
        await enqueue({
          opId:        uuidv7(),
          entity:      originalOp.entity,
          entityId:    originalOp.entityId,
          fields:      lostFields,
          baseVersion: 0,
          clientTs:    nowUTC(),
        });
        await flush();
      })();
    },
  });
}

// ── Flush ─────────────────────────────────────────────────────────────────────

/**
 * Apply one batch's worth of server results to the outbox + local state.
 * Returns the ops the server said nothing about (see the caller).
 */
async function settle(batch: Op[], results: (SyncResult | SyncError)[]): Promise<Op[]> {
  const opMap = new Map(batch.map((o) => [o.opId, o]));

  for (const r of results) {
    const op = opMap.get(r.opId);
    opMap.delete(r.opId);

    if ('error' in r) {
      // A per-op error is the server's DETERMINISTIC verdict on this op — it was
      // reached inside the batch transaction and re-sending the op unchanged would
      // reach it again. So the op leaves the outbox rather than retrying forever.
      //
      // But it must not leave SILENTLY. The optimistic mutation already painted
      // this edit into the UI, so dropping the op with no signal leaves the screen
      // showing a change that exists nowhere else — the user's edit is gone and the
      // app is the only thing that still believes in it. Everything except the
      // deleted-entity case therefore raises a conflict with a re-apply action.
      if (r.error.includes('not found')) {
        // Deleted on another device: reconcile local state instead. There is nothing
        // to re-apply to, so this is the one rejection with no conflict to raise.
        if (op?.entity === 'task')  mutateTasks((prev)  => prev?.filter((t) => t.id !== op.entityId));
        if (op?.entity === 'block') mutateBlocks((prev) => prev?.filter((b) => b.id !== op.entityId));
      } else if (op) {
        surfaceConflict(op, Object.keys(op.fields), 'rejected');
      }
      await ack(r.opId);
    } else {
      await ack(r.opId);
      if (r.dropped.length > 0 && op) surfaceConflict(op, r.dropped, 'overwritten');
    }
  }

  return [...opMap.values()];
}

/**
 * Drain the op-log oldest-first via POST /api/sync, in server-sized batches.
 *
 * Re-entrant calls while a flush is in progress are no-ops. A failed round trip
 * arms ONE backoff retry (`scheduleRetry`) and returns; it never re-enters flush
 * directly, which is what stops an offline client from spinning.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const queued = await pending();
      if (queued.length === 0) {
        clearRetry();
        return;
      }

      // Never send more than the server will accept in one request.
      const batch = queued.slice(0, SYNC_BATCH_LIMIT);
      await markInflight(batch.map((o) => o.opId));

      let results: (SyncResult | SyncError)[];
      try {
        results = await api.sync.apply(batch as SyncOp[]);
      } catch (err) {
        // Offline, a 5xx, or a request the server refused outright. The ops go back
        // to 'pending' — they are the user's edits and are not ours to discard — and
        // the next attempt waits for the backoff rather than starting immediately.
        await requeueInflight();
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          console.warn(`sync rejected the batch (HTTP ${err.status}): ${err.message}`);
        }
        scheduleRetry();
        return;
      }

      clearRetry(); // the server answered; reset the backoff
      const unanswered = await settle(batch, results);

      // Defensive: a result for every op is the contract, so a gap is a server bug
      // rather than an op-level verdict. Put those back and let the backoff pace the
      // next attempt — looping on them here would spin against a server that keeps
      // omitting them.
      if (unanswered.length > 0) {
        await requeueInflight();
        scheduleRetry();
        return;
      }

      // Otherwise keep going: `queued` may have exceeded one batch, and more ops can
      // be enqueued while we are in here. Every op in the batch just left the queue,
      // so each pass is strictly shorter and this terminates.
    }
  } finally {
    flushing = false;
  }
}

// Register flush as the pre-reconnect hook so SSE catch-up frames don't
// arrive as surprising "remote" edits for ops we're about to send.
registerFlushHook(flush);

// Re-flush whenever the browser reports it's back online. Connectivity returning is
// new information, so the accumulated backoff no longer applies — drop it and go now
// instead of sitting out the rest of a 30s wait the outage earned.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { clearRetry(); void flush(); });
}

// Phase L (gap 9): flush when the Service Worker signals a push arrived.
// The SW posts { type: 'sync-flush' } to all window clients on each push
// event so queued writes don't stall while the tab is backgrounded.
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    if ((e.data as { type?: string } | null)?.type === 'sync-flush') void flush();
  });
}

// ── Optimistic mutation helpers ────────────────────────────────────────────────

/**
 * Patch a task optimistically and enqueue a sync op.
 * `fields` must be snake_case API shape (matching the server sync whitelist).
 */
export async function patchTask(id: string, fields: Partial<Task>): Promise<void> {
  mutateTasks((prev) => prev?.map((t) => (t.id === id ? { ...t, ...fields } : t)));
  await enqueue({
    opId:        uuidv7(),
    entity:      'task',
    entityId:    id,
    fields:      fields as Record<string, unknown>,
    baseVersion: 0,
    clientTs:    nowUTC(),
  });
  void flush();
}

/**
 * Patch a block optimistically and enqueue a sync op.
 * `fields` must be snake_case API shape (matching the server sync whitelist).
 */
export async function patchBlock(id: string, fields: Partial<Block>): Promise<void> {
  mutateBlocks((prev) => prev?.map((b) => (b.id === id ? { ...b, ...fields } : b)));
  await enqueue({
    opId:        uuidv7(),
    entity:      'block',
    entityId:    id,
    fields:      fields as Record<string, unknown>,
    baseVersion: 0,
    clientTs:    nowUTC(),
  });
  void flush();
}

/**
 * Queue a field-scoped objective op (Follow-up 2, option B). Objectives are a
 * server-derived read surface delivered via GET /api/objectives, so there is no
 * local objective store to mutate optimistically — this only durably queues the
 * op so an offline edit round-trips through POST /api/sync on reconnect.
 * `fields` must be snake_case API shape (matching OBJECTIVE_FIELDS on the server).
 */
export async function enqueueObjectiveOp(id: string, fields: Record<string, unknown>): Promise<void> {
  await enqueue({ opId: uuidv7(), entity: 'objective', entityId: id, fields, baseVersion: 0, clientTs: nowUTC() });
  void flush();
}

/**
 * Queue an objective↔task link change. `linkId` is the join row's surrogate id
 * (server migration 0087); `linked` is 1 to link, 0 to unlink (tombstone).
 */
export async function enqueueObjectiveTaskOp(linkId: string, linked: 0 | 1): Promise<void> {
  await enqueue({ opId: uuidv7(), entity: 'objective_task', entityId: linkId, fields: { linked }, baseVersion: 0, clientTs: nowUTC() });
  void flush();
}
