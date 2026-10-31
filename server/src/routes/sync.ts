import Router from '@koa/router';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { applyOp, type Op, type ApplyResult } from '../sync/apply.js';
import { mirrorTaskStatusToBlocks } from '../services/block-task-sync.js';
import { applySyncedObjectiveUpkeep } from '../services/objectives.js';
import { logSyncEvent, emitToClients, maxSyncSeq, readSyncGap } from './sse.js';

/** Maximum ops in a single batch — prevents runaway requests. */
const BATCH_LIMIT = 200;

/** Digits only, short enough that `Number()` is exact: `since` is a cursor, never arithmetic. */
const CURSOR_RE = /^\d{1,15}$/;

/** A stored payload is JSON the server wrote itself; if one ever is not, hand back the raw text, as the SSE frame would. */
function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

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
          const result = await applyOp(op, ownerId);
          const statusAfter = result.applied['status'] as string | undefined;
          if (
            statusBefore !== undefined &&
            statusAfter !== undefined &&
            (statusBefore === 'done') !== (statusAfter === 'done') &&
            (statusAfter === 'done' || ['open', 'scheduled', 'in_progress'].includes(statusAfter))
          ) {
            for (const blockId of await mirrorTaskStatusToBlocks(op.entityId, ownerId)) {
              const blockPayload = { id: blockId };
              const blockSeq = await logSyncEvent(ownerId, 'block:updated', blockPayload);
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
          const seq = await logSyncEvent(ownerId, eventName, payload);
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

  /**
   * GET /api/sync/changes?since=<seq>
   *
   * The polling twin of the SSE stream (`/api/events`): the same `sync_events` rows, the
   * same replay window and the same overflow rule, answered as one JSON document. It is for
   * a client that cannot hold an `EventSource`: the Capacitor app shell is served from its
   * own origin, so an `EventSource` there carries no session cookie and the server allows
   * no foreign origin. Such a client sends its requests through the native HTTP stack,
   * cookie and all, and calls this with the `cursor` from its last answer.
   *
   *   no `since`   start from now: no events, `cursor` is the owner's latest seq. Not the
   *                same as `since=0`, which means "everything after 0". An owner with no
   *                events has cursor 0, and its first event must not be skipped.
   *   `since=N`    the events after N, in order (at most 500), `cursor` is the last one's
   *                seq (N itself when there are none).
   *   gap over 500 no events, `resync: true`, `cursor` is the latest seq: refetch
   *                everything, then carry on from the cursor. The same call the stream
   *                makes with a `sync:resync` frame.
   *   ahead of the log  the same answer. A cursor higher than anything the owner has means
   *                the log it came from is gone (the database was restored from an older
   *                copy, or the server was set up afresh at the same address). The stream
   *                shrugs that off, because it pushes whatever happens next whatever the
   *                cursor says; a poller would hear nothing until the log caught up to its
   *                number, so it is told to start over from the real one.
   *
   * Each event is `{ seq, event, data }`, the parts of an SSE frame with `data` already
   * parsed. Behind the router-wide `requireAuth` like every other `/api` route: the session
   * cookie in `sso` mode, `x-api-key` in `standalone`, and the `planning:read` scope.
   */
  router.get('/api/sync/changes', async (ctx) => {
    const raw = ctx.query.since;
    let since: number | null = null;
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !CURSOR_RE.test(raw)) {
        ctx.status = 400;
        ctx.body = { error: 'since must be a non-negative integer' };
        return;
      }
      since = Number(raw);
    }

    // A poll answer is stale the moment it is sent; keep any proxy from replaying one.
    ctx.set('Cache-Control', 'no-store');
    const ownerId = currentOwnerId();

    if (since === null) {
      ctx.body = { events: [], cursor: await maxSyncSeq(ownerId), resync: false };
      return;
    }

    const gap = await readSyncGap(ownerId, since);
    if (gap.resync) {
      ctx.body = { events: [], cursor: gap.maxSeq, resync: true };
      return;
    }
    if (gap.rows.length === 0) {
      const head = await maxSyncSeq(ownerId);
      if (since > head) {
        ctx.body = { events: [], cursor: head, resync: true };
        return;
      }
    }
    const events = gap.rows.map((row) => ({
      seq: Number(row.seq),
      event: row.event,
      data: parsePayload(row.payload),
    }));
    ctx.body = { events, cursor: events.length > 0 ? events[events.length - 1]!.seq : since, resync: false };
  });

  return router;
}
