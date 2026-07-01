/**
 * Phase L: optimistic mutation helpers + op-log flush.
 *
 * Every public function here:
 *  1. Applies the change locally (optimistic update via SolidJS resource mutate)
 *  2. Enqueues a field-scoped Op in IndexedDB
 *  3. Kicks off flush() (best-effort; no-op while offline)
 *
 * flush() drains the queue oldest-first via POST /api/sync.  On network
 * failure the ops stay 'pending' and are retried on the next online event
 * or SSE reconnect.
 */

import { enqueue, pending, ack, markInflight, requeueInflight, type Op } from '../lib/oplog.js';
import { api, type SyncOp, type SyncResult } from '../lib/api.js';
import { registerFlushHook } from '../lib/sse.js';
import { mutateTasks, mutateBlocks, tasks, blocks } from './index.js';
import { addConflict } from './conflicts.js';
import type { Task, Block } from '../lib/api.js';

// On module load, recover any ops left inflight by a previous session (crash / hard reload).
void requeueInflight();

let flushing = false;

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

function surfaceConflict(result: SyncResult, originalOp: Op): void {
  const droppedFields: Record<string, unknown> = Object.fromEntries(
    result.dropped.map((f) => [f, originalOp.fields[f]]),
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
    fields:      result.dropped,
    recover: () => {
      void enqueue({
        opId:        uuidv7(),
        entity:      originalOp.entity,
        entityId:    originalOp.entityId,
        fields:      droppedFields,
        baseVersion: 0,
        clientTs:    nowUTC(),
      });
      void flush();
    },
  });
}

// ── Flush ─────────────────────────────────────────────────────────────────────

/**
 * Drain the op-log oldest-first via POST /api/sync.
 * Re-entrant calls while a flush is in progress are no-ops; when the flush
 * completes it re-checks for newly-arrived ops and self-kicks if needed.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const ops = await pending();
    if (ops.length === 0) return;

    await markInflight(ops.map((o) => o.opId));

    let results: (SyncResult | { opId: string; error: string })[];
    try {
      results = await api.sync.apply(ops as SyncOp[]);
    } catch {
      // Network or server error — requeue and wait for next online event.
      await requeueInflight();
      return;
    }

    const opMap = new Map(ops.map((o) => [o.opId, o]));
    for (const r of results) {
      if ('error' in r) {
        // Server rejected this op. If the entity was deleted on another device,
        // remove it from local state immediately rather than leaving a ghost.
        if (r.error.includes('not found')) {
          const op = opMap.get(r.opId);
          if (op?.entity === 'task')  mutateTasks((prev)  => prev?.filter((t) => t.id !== op.entityId));
          if (op?.entity === 'block') mutateBlocks((prev) => prev?.filter((b) => b.id !== op.entityId));
        }
        await ack(r.opId);
      } else {
        await ack(r.opId);
        if (r.dropped.length > 0) {
          const orig = opMap.get(r.opId);
          if (orig) surfaceConflict(r, orig);
        }
      }
    }
  } finally {
    flushing = false;
    // If more ops arrived while we were flushing, kick off another round.
    const remaining = await pending();
    if (remaining.length > 0) void flush();
  }
}

// Register flush as the pre-reconnect hook so SSE catch-up frames don't
// arrive as surprising "remote" edits for ops we're about to send.
registerFlushHook(flush);

// Re-flush whenever the browser reports it's back online.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flush());
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
