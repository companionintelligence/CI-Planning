import Router from '@koa/router';
import { PassThrough } from 'node:stream';
import { currentOwnerId } from '../lib/context.js';
import { sqlite } from '../db/index.js';

const clients = new Map<PassThrough, string>(); // stream → ownerId

/** Maximum events replayed to a reconnecting client before falling back to a full resync. */
const REPLAY_LIMIT = 500;

/** Register an SSE client for an owner. Returns an unregister function. */
export function registerClient(stream: PassThrough, ownerId: string): () => void {
  clients.set(stream, ownerId);
  return () => { clients.delete(stream); };
}

/**
 * Write one row to the append-only `sync_events` table for catch-up replay.
 * Returns the assigned `seq` (0 on write failure, e.g. pre-migration test state).
 * Safe to call inside a `sqlite.transaction()` callback — the insert joins the
 * caller's transaction atomically.
 */
export function logSyncEvent(ownerId: string, event: string, data: unknown): number {
  const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const entity   = event.split(':')[0] ?? '';
  const entityId = typeof d['id'] === 'string' ? d['id'] : '';
  const version  = typeof d['version'] === 'number' ? d['version'] : null;
  const at       = new Date().toISOString();
  try {
    const { lastInsertRowid } = sqlite
      .prepare(
        `INSERT INTO sync_events (owner_id, entity, entity_id, version, event, payload, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ownerId, entity, entityId, version, event, JSON.stringify(data), at);
    return Number(lastInsertRowid);
  } catch {
    // sync_events table may not exist yet (pre-migration test state); continue
    return 0;
  }
}

/** Emit one SSE frame to all live streams belonging to `ownerId`. */
export function emitToClients(ownerId: string, seq: number, event: string, data: unknown): void {
  const idLine = seq > 0 ? `id: ${seq}\n` : '';
  const msg = `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [c, owner] of clients) if (owner === ownerId) c.write(msg);
}

/**
 * Log to `sync_events` and broadcast to all live streams for the owner.
 * Called by every mutating route — the existing fire-and-forget contract is
 * unchanged; the log is a side effect that powers catch-up replay (§5).
 */
export function broadcast(ownerId: string, event: string, data: unknown): void {
  const seq = logSyncEvent(ownerId, event, data);
  emitToClients(ownerId, seq, event, data);
}

export function sseRouter() {
  const router = new Router();

  router.get('/api/events', async (ctx) => {
    const stream = new PassThrough();
    ctx.set({
      'Content-Type':     'text/event-stream',
      'Cache-Control':    'no-cache',
      'Connection':       'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    ctx.status = 200;
    ctx.body   = stream;

    const ownerId = currentOwnerId();
    const unregister = registerClient(stream, ownerId);

    // Phase L §5: SSE catch-up after disconnect.
    // The browser sends `Last-Event-ID` automatically on reconnect within a session.
    // On an initial page load the client passes `?lastEventId=<cursor>` from
    // its persisted localStorage so the gap is filled even across reloads.
    const rawSeq = ctx.get('Last-Event-ID') || (ctx.query.lastEventId as string | undefined) || '';
    const lastSeq = parseInt(rawSeq, 10);

    if (!isNaN(lastSeq) && lastSeq > 0) {
      try {
        const missed = sqlite
          .prepare(
            `SELECT seq, event, payload
               FROM sync_events
              WHERE owner_id = ? AND seq > ?
              ORDER BY seq
              LIMIT ?`,
          )
          .all(ownerId, lastSeq, REPLAY_LIMIT + 1) as { seq: number; event: string; payload: string }[];

        if (missed.length > REPLAY_LIMIT) {
          // Client has been offline long enough that replaying the full gap would
          // be unbounded — tell it to refetch all resources instead.
          // Include id: <maxSeq> so the client cursor advances past the overflow
          // point; without it persistCursor is a no-op and every reconnect loops.
          const maxRow = sqlite
            .prepare(`SELECT MAX(seq) AS seq FROM sync_events WHERE owner_id = ?`)
            .get(ownerId) as { seq: number | null } | undefined;
          const maxSeq = maxRow?.seq ?? 0;
          const idLine = maxSeq > 0 ? `id: ${maxSeq}\n` : '';
          stream.write(`${idLine}event: sync:resync\ndata: {}\n\n`);
        } else {
          for (const row of missed) {
            stream.write(`id: ${row.seq}\nevent: ${row.event}\ndata: ${row.payload}\n\n`);
          }
        }
      } catch {
        // sync_events not yet created (pre-migration); skip catch-up gracefully.
      }
    }

    stream.write(':ok\n\n');

    const heartbeat = setInterval(() => stream.write(':heartbeat\n\n'), 25_000);
    ctx.req.on('close', () => {
      clearInterval(heartbeat);
      unregister();
    });
  });

  return router;
}
