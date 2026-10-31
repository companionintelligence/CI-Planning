import Router from '@koa/router';
import { PassThrough } from 'node:stream';
import { currentOwnerId } from '../lib/context.js';
import { store } from '../db/store.js';
import { logger } from '../lib/logger.js';

const clients = new Map<PassThrough, string>(); // stream → ownerId

/** Maximum events replayed to a reconnecting client before falling back to a full resync. */
const REPLAY_LIMIT = 500;

/**
 * A stream buffering more than this many un-flushed bytes has stopped draining — the
 * client is gone (dead socket, backgrounded tab the OS paused, a proxy that swallowed
 * the close) without ever telling us. Node's `Writable` does not enforce any such cap
 * on its own: `write()` keeps accepting data and the internal buffer keeps growing for
 * as long as we keep calling it, which for a chatty owner and one stuck client is
 * unbounded growth with no ceiling.
 *
 * 1MB is generous for a live client — SSE frames here are small JSON payloads, so a
 * healthy reader drains between broadcasts and never gets remotely close — while still
 * bounding the worst case to a fixed, small cost per stuck stream instead of "forever."
 */
const MAX_BUFFERED_BYTES = 1_000_000;

/** Error shape recognized for "this table doesn't exist YET", never for a live failure.
 *
 * Only reachable in the pre-migration test harness (boot.ts awaits migrations to
 * completion BEFORE the server starts listening, so a real request can never observe
 * `sync_events` missing) — but the check still has to be precise: it must not also
 * swallow a genuine insert failure, which is the whole defect this exists to close.
 * SQLite's own wording is "no such table: X"; Postgres reports SQLSTATE 42P01
 * (undefined_table) on its error object, which survives the store facade's pass-through
 * untouched (db/pg.ts re-throws driver errors verbatim).
 */
export function isMissingTableError(err: unknown): boolean {
  if ((err as { code?: string } | null)?.code === '42P01') return true;
  return /no such table/i.test((err as Error)?.message ?? '');
}

/** Register an SSE client for an owner. Returns an unregister function. */
export function registerClient(stream: PassThrough, ownerId: string): () => void {
  clients.set(stream, ownerId);
  return () => { clients.delete(stream); };
}

/** Test-only: is this stream still registered? Lets a backpressure test assert
 *  disconnection without reaching into the module-private `clients` map directly. */
export function __isRegistered(stream: PassThrough): boolean {
  return clients.has(stream);
}

/** Test-only: how many streams are registered. For a test that opens a real connection and
 *  has no handle on the server-side stream, to wait for the route to see it come and go. */
export function __clientCount(): number {
  return clients.size;
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
  } catch (err) {
    if (isMissingTableError(err)) return 0; // pre-migration test state; see the check's own doc
    // A REAL insert failure, not the documented pre-migration case. Returning 0 here is
    // still correct — the caller (broadcast) must degrade to a live-only frame rather
    // than lose the event outright — but doing so SILENTLY is not: `id: 0` tells a
    // reconnecting client's cursor nothing, so this one event becomes permanently
    // unreplayable with no trace of why. That has to be loud.
    logger.error('logSyncEvent insert failed — this event will not be replayable on reconnect', {
      ownerId, event, err: (err as Error).message,
    });
    return 0;
  }
}

/** Emit one SSE frame to all live streams belonging to `ownerId`. */
export function emitToClients(ownerId: string, seq: number, event: string, data: unknown): void {
  const idLine = seq > 0 ? `id: ${seq}\n` : '';
  const msg = `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [c, owner] of clients) {
    if (owner !== ownerId) continue;
    c.write(msg);
    // write()'s own return value (false past highWaterMark) fires on every healthy
    // client too, briefly, under a normal burst — it means "buffering," not "dead."
    // `writableLength` is the real signal: bytes STILL sitting there, unconsumed, right
    // now. A live reader drains between broadcasts and never gets near this cap; a dead
    // one accumulates every single frame forever, which is exactly the growth this cap
    // exists to bound. Cutting it loose here — rather than merely noticing the problem —
    // is what actually stops the buffer growing: the client is out of `clients` the
    // moment this returns, so nothing broadcast after this can ever write to it again.
    if (c.writableLength > MAX_BUFFERED_BYTES) {
      logger.warn('SSE client fell too far behind — disconnecting', {
        ownerId, bufferedBytes: c.writableLength,
      });
      clients.delete(c);
      c.destroy();
    }
  }
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
      } catch (err) {
        if (isMissingTableError(err)) {
          // sync_events not yet created — pre-migration test state; see the check's own doc.
        } else {
          // A REAL failure, not the documented pre-migration case. Falling through to
          // ':ok' silently would leave the client's cursor exactly where it was, with
          // NO signal that its catch-up read failed — it would just quietly miss the
          // gap until whatever reconnects it next. Tell it to resync instead: the same
          // escape hatch already used when the gap is too large to replay. No id: line
          // here — the read that would have told us maxSeq is the very thing that just
          // failed, so the cursor advances on the client's NEXT successful catch-up.
          logger.error('SSE catch-up read failed — telling the client to resync instead', {
            ownerId, err: (err as Error).message,
          });
          stream.write('event: sync:resync\ndata: {}\n\n');
        }
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
