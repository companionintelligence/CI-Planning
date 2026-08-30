import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  registerClient, emitToClients, logSyncEvent, isMissingTableError, __isRegistered,
} from '../src/routes/sse.js';
import { logger } from '../src/lib/logger.js';
import { resetDb } from './helpers.js';

/**
 * Three adversarial-review fixes in routes/sse.ts:
 *
 *  1. isMissingTableError — logSyncEvent's catch used to swallow EVERY failure
 *     identically ("sync_events table may not exist yet"), including a genuine insert
 *     failure that has nothing to do with migrations. This is the classifier that lets
 *     it tell the two apart; tested here as a pure function against both backends'
 *     actual error shapes, with no DB involved (the real, positive "table is missing"
 *     case is unreachable in a live process — boot.ts awaits migrations before the
 *     server listens — so there is nothing safe to integration-test there; dropping a
 *     table the rest of this shared suite depends on to manufacture one is a real risk
 *     for no proof this unit-level coverage doesn't already give).
 *  2. logSyncEvent now logs loudly (and still returns 0, still never throws to
 *     `broadcast`) on a REAL failure — proven with a foreign-key violation, which is a
 *     genuine, reversible, side-effect-free way to make one specific insert fail.
 *  3. emitToClients disconnects a stream whose buffered backlog has grown past the
 *     cap, so a stuck client can no longer be written to at all — proven against a
 *     real, deliberately-never-drained PassThrough (confirmed experimentally:
 *     `writableLength` climbs unboundedly on a stream nothing reads from).
 */

beforeEach(() => resetDb());

describe('isMissingTableError', () => {
  it('recognizes SQLite\'s wording', () => {
    expect(isMissingTableError(new Error('no such table: sync_events'))).toBe(true);
    expect(isMissingTableError(new Error('SQLITE_ERROR: no such table: sync_events'))).toBe(true);
  });

  it('recognizes Postgres\'s SQLSTATE (42P01, undefined_table)', () => {
    const pgErr = Object.assign(new Error('relation "sync_events" does not exist'), { code: '42P01' });
    expect(isMissingTableError(pgErr)).toBe(true);
  });

  it('does NOT classify an unrelated failure as a missing table', () => {
    expect(isMissingTableError(new Error('database is locked'))).toBe(false);
    expect(isMissingTableError(new Error('FOREIGN KEY constraint failed'))).toBe(false);
    expect(isMissingTableError(Object.assign(new Error('connection terminated'), { code: '08006' }))).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
  });
});

describe('logSyncEvent — a real failure is not silent', () => {
  it('logs loudly, still returns 0, and never throws', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    // sync_events.owner_id REFERENCES owners(id), enforced (migration 0098) — a
    // nonexistent owner_id is a clean, reversible way to make this ONE insert
    // genuinely fail without touching the table or any other test's state.
    let seq: number | undefined;
    await expect(
      (async () => { seq = await logSyncEvent('no-such-owner', 'task:updated', { id: 't1' }); })(),
    ).resolves.not.toThrow();

    expect(seq).toBe(0); // the documented degrade — broadcast still emits, live-only
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg, meta] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/insert failed/i);
    expect(meta).toMatchObject({ ownerId: 'no-such-owner', event: 'task:updated' });

    errorSpy.mockRestore();
  });

  it('a genuinely successful write logs nothing', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const { SYSTEM_OWNER } = await import('../src/lib/context.js');

    const seq = await logSyncEvent(SYSTEM_OWNER, 'task:updated', { id: 't2' });
    expect(seq).toBeGreaterThan(0);
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('emitToClients — backpressure', () => {
  it('disconnects a stream whose buffered backlog exceeds the cap', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    // Deliberately never read from — no 'data' listener, never resumed, never piped.
    // This is the exact shape a stuck SSE client's server-side stream takes: nothing
    // is wrong with the write, nothing IS being consumed.
    const stuck = new PassThrough();
    const off = registerClient(stuck, 'owner-a');
    expect(__isRegistered(stuck)).toBe(true);

    // Each frame is a couple hundred bytes; a few thousand broadcasts comfortably
    // cross the 1MB cap on a stream that never drains (measured: ~200 bytes/write
    // once past the initial ~16KB highWaterMark absorbs the first ~100 or so).
    for (let i = 0; i < 6_000 && __isRegistered(stuck); i++) {
      emitToClients('owner-a', i + 1, 'task:updated', { id: `t${i}`, note: 'x'.repeat(150) });
    }

    expect(__isRegistered(stuck)).toBe(false); // cut loose
    expect(warnSpy).toHaveBeenCalledWith(
      'SSE client fell too far behind — disconnecting',
      expect.objectContaining({ ownerId: 'owner-a' }),
    );

    // Once disconnected, NOTHING further is written to it — the buffer stops growing,
    // which is the actual fix (not just noticing the problem).
    const bufferedAtDisconnect = stuck.writableLength;
    emitToClients('owner-a', 99_999, 'task:updated', { id: 'after' });
    expect(stuck.writableLength).toBe(bufferedAtDisconnect);

    off();
    warnSpy.mockRestore();
  });

  it('never disconnects a client that actually drains', () => {
    const drained = new PassThrough();
    // A live reader: attaching 'data' (and leaving it flowing) is what makes Node
    // actually drain the internal buffer as data arrives, exactly like a real HTTP
    // response being consumed by a connected browser.
    drained.on('data', () => {});
    const off = registerClient(drained, 'owner-b');

    for (let i = 0; i < 6_000; i++) {
      emitToClients('owner-b', i + 1, 'task:updated', { id: `t${i}`, note: 'x'.repeat(150) });
    }

    expect(__isRegistered(drained)).toBe(true);
    off();
  });

  it('never touches a stream belonging to a different owner', () => {
    const other = new PassThrough();
    other.on('data', () => {});
    const off = registerClient(other, 'owner-c');

    emitToClients('owner-a', 1, 'task:updated', { id: 't1' });

    expect(__isRegistered(other)).toBe(true);
    off();
  });
});
