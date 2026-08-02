import Router from '@koa/router';
// `sqlite` remains ONLY as applyOp's handle argument — it dies when sync/apply.ts
// ports to the facade. The route's own statements go through store().
import { sqlite } from '../db/index.js';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { applyOp, type Op, type ApplyResult } from '../sync/apply.js';
import { mirrorTaskStatusToBlocks } from '../services/block-task-sync.js';
import { applySyncedObjectiveUpkeep } from '../services/objectives.js';
import { logSyncEvent, emitToClients } from './sse.js';

/** Maximum ops in a single batch — prevents runaway requests. */
const BATCH_LIMIT = 200;

/**
 * POST /api/sync
 *
 * Apply a batch of field-level ops in one transaction. Each op is applied
 * with field-level LWW + monotonic completion (§3/§4). The full batch commits
 * atomically; individual op failures are reported per-op without aborting the
 * batch. SSE events are emitted AFTER the transaction commits so clients never
 * receive events for uncommitted data.
 *
 * Request:  { ops: Op[] }
 * Response: { results: (ApplyResult | { opId, error })[] }
 */
export function syncRouter() {
  const router = new Router();

  router.post('/api/sync', async (ctx) => {
    const body = ctx.request.body as { ops?: unknown };
    if (!Array.isArray(body?.ops)) {
      ctx.status = 400;
      ctx.body = { error: 'ops must be an array' };
      return;
    }
    const ops = body.ops as Op[];
    if (ops.length > BATCH_LIMIT) {
      ctx.status = 400;
      ctx.body = { error: `batch too large (max ${BATCH_LIMIT})` };
      return;
    }

    const ownerId = currentOwnerId();

    // Collect (seq, event, payload) tuples to emit after the tx commits.
    const toEmit: { seq: number; event: string; payload: unknown }[] = [];
    const results: (ApplyResult | { opId: string; error: string })[] = [];

    await store().transaction(async () => {
      for (const op of ops) {
        try {
          // Capture the pre-merge status so a merged completion (or reopen) can run the
          // task→block done-state mirror below — applyOp writes columns directly and
          // never goes through services/tasks.ts, so without this a completion synced
          // from another device would leave its Planner block sitting at 'planned'.
          const statusBefore =
            op.entity === 'task' && op.fields && 'status' in op.fields
              ? (await store().prepare(`SELECT status FROM tasks WHERE id = ? AND owner_id = ?`).get<{ status: string }>(op.entityId, ownerId))?.status
              : undefined;
          const result = applyOp(sqlite, op, ownerId);
          const statusAfter = result.applied['status'] as string | undefined;
          if (
            statusBefore !== undefined &&
            statusAfter !== undefined &&
            (statusBefore === 'done') !== (statusAfter === 'done') &&
            (statusAfter === 'done' || ['open', 'scheduled', 'in_progress'].includes(statusAfter))
          ) {
            for (const blockId of await mirrorTaskStatusToBlocks(op.entityId, ownerId)) {
              const blockPayload = { id: blockId };
              const blockSeq = logSyncEvent(ownerId, 'block:updated', blockPayload);
              toEmit.push({ seq: blockSeq, event: 'block:updated', payload: blockPayload });
            }
          }
          // Same reason as the mirror above — applyOp writes columns directly and never
          // goes through services/objectives.ts, so the tree invariants it maintains have
          // to be re-established by hand. Chiefly: a synced `archived_at` must cascade over
          // the live subtree the way archiveObjective does, or archiving offline silently
          // orphans every child (buildTree then re-roots them to top level).
          if (op.entity === 'objective') {
            // Awaited, not floated: the upkeep must land INSIDE this transaction, and
            // before the sync event below announces the op as applied. Detached, the
            // archive cascade would race the commit and the client could observe an
            // archived root whose subtree is still live.
            await applySyncedObjectiveUpkeep(ownerId, op.entityId, result.applied);
          }
          // An objective_task link change surfaces as an objective update (the
          // client re-derives the tree from the objective's links).
          const eventEntity = op.entity === 'objective_task' ? 'objective' : op.entity;
          const eventName = `${eventEntity}:updated`;
          const payload = { id: op.entityId, version: result.version, ...result.applied };
          // logSyncEvent is inside the transaction — it shares the same connection
          // and therefore the same tx; a rollback would also roll back the log row.
          const seq = logSyncEvent(ownerId, eventName, payload);
          toEmit.push({ seq, event: eventName, payload });
          results.push(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'apply failed';
          results.push({ opId: op.opId, error: msg });
        }
      }
    });

    // Broadcast after the transaction commits so events are never for rolled-back data.
    for (const { seq, event, payload } of toEmit) {
      emitToClients(ownerId, seq, event, payload);
    }

    ctx.body = { results };
  });

  return router;
}
