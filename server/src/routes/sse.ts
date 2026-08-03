import Router from '@koa/router';
import { PassThrough } from 'node:stream';
import { currentOwnerId } from '../lib/context.js';
import { store } from '../db/store.js';

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
 * Safe to call inside a `store().transaction()` callback — the insert joins the
 * caller's transaction.
 *
 * `RETURNING seq` rather than `lastInsertRowid`: the store facade's `run()` reports only
 * `{ changes }`, deliberately, because `lastInsertRowid` has no Postgres equivalent (see
 * db/pg.ts). RETURNING is supported by both backends and retires one of the two
 * documented dialect deltas.
 */
export async function logSyncEvent(ownerId: string, event: string, data: unknown): Promise<number> {
  const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const entity   = event.split(':')[0] ?? '';
  const entityId = typeof d['id'] === 'string' ? d['id'] : '';
  const version  = typeof d['version'] === 'number' ? d['version'] : null;
  const at       = new Date().toISOString();
  try {
    const row = await store()
      .prepare(
        `INSERT INTO sync_events (owner_id, entity, entity_id, version, event, payload, at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      )
      .get<{ seq: number }>(ownerId, entity, entityId, version, event, JSON.stringify(data), at);
    return Number(row?.seq ?? 0);
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

/** In-flight broadcasts, so {@link flushBroadcasts} can wait for them. */
const inFlight = new Set<Promise<void>>();

/**
 * Log to `sync_events` and broadcast to all live streams for the owner.
 *
 * STAYS SYNCHRONOUS AND FIRE-AND-FORGET — the same call it always was, at all 192 call
 * sites. This is the wave-8 design decision the plan deferred, and it lands the same way
 * `writeAudit` did: async-ifying it would turn every mutating route, service and resolver
 * into an awaiting caller for a result NONE of them consume. `broadcast` returns void and
 * always has.
 *
 * What could not simply be floated is the `seq`: it becomes the SSE frame's `id:` line,
 * which is what powers Last-Event-ID catch-up. So the emit moves INSIDE the promise chain
 * rather than running before the insert resolves — the frame still carries the correct
 * seq, one microtask later. SSE delivery is asynchronous by nature, so nothing observable
 * changes; what would have broken is emitting with `seq` unresolved.
 *
 * A failed log must never take down the mutation that triggered it, so the chain swallows
 * its own errors — but it still emits, because a client that misses the id line degrades
 * to a live-only frame rather than losing the event entirely.
 */
export function broadcast(ownerId: string, event: string, data: unknown): void {
  const p: Promise<void> = logSyncEvent(ownerId, event, data)
    .then(
      (seq) => { emitToClients(ownerId, seq, event, data); },
      () => { emitToClients(ownerId, 0, event, data); },
    )
    .finally(() => { inFlight.delete(p); });
  inFlight.add(p);
}

/**
 * Wait for every broadcast issued so far — the {@link flushAudits} twin.
 *
 * For tests (and anything else) that read `sync_events` immediately after the mutation
 * that wrote it: with a synchronous SQLite handle the row was always already there; now
 * it lands a microtask later, and under Postgres a network round trip later. Loops rather
 * than draining once, because awaiting the current set can itself let a queued write start.
 */
export async function flushBroadcasts(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
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
        const missed = await store()
          .prepare(
            `SELECT seq, event, payload
               FROM sync_events
              WHERE owner_id = ? AND seq > ?
              ORDER BY seq
              LIMIT ?`,
          )
          .all<{ seq: number; event: string; payload: string }>(ownerId, lastSeq, REPLAY_LIMIT + 1);

        if (missed.length > REPLAY_LIMIT) {
          // Client has been offline long enough that replaying the full gap would
          // be unbounded — tell it to refetch all resources instead.
          // Include id: <maxSeq> so the client cursor advances past the overflow
          // point; without it persistCursor is a no-op and every reconnect loops.
          const maxRow = await store()
            .prepare(`SELECT MAX(seq) AS seq FROM sync_events WHERE owner_id = ?`)
            .get<{ seq: number | null }>(ownerId);
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
