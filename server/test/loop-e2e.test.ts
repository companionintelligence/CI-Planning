/**
 * End-to-end loop invariant tests.
 *
 * Exercises the full ingest → sync → sync-back cycle using FixtureConnector.
 * No real OAuth, no network — all offline.
 *
 * Invariants covered:
 *   I7  — outbound createEvent is idempotent under re-queue
 *   I8  — full re-init after cursor expiry never deletes existing inbound blocks
 *   I9  — a CP-pushed outbound event is not re-mirrored as an inbound meeting block
 *   I10 — PATCH title/start/end on an inbound meeting block returns 422
 *   I11 — multiple sync cycles produce exactly one meeting block per remote event
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { FixtureConnector } from '../src/connectors/fixture.js';
import { syncConnector } from '../src/agents/sync.js';
import { config } from '../src/lib/config.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

const sync = (c: FixtureConnector) => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => syncConnector(c));

function futureDate(daysAhead: number, hourOffset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function meetingBlocks() {
  return sqlite
    .prepare("SELECT id, title FROM time_blocks WHERE block_kind = 'meeting'")
    .all() as { id: string; title: string }[];
}

function externalRows(direction?: 'inbound' | 'outbound') {
  const q = direction
    ? `SELECT * FROM external_events WHERE direction = '${direction}'`
    : `SELECT * FROM external_events`;
  return sqlite.prepare(q).all() as { id: string; external_id: string; direction: string; block_id: string }[];
}

describe('loop invariants (fixture, offline)', () => {
  let connector: FixtureConnector;
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.close());

  beforeEach(() => {
    resetDb();
    connector = new FixtureConnector('google', 'primary');
  });

  // ── I11 ─────────────────────────────────────────────────────────────────────

  it('I11: multiple sync cycles produce exactly one meeting block per remote event', async () => {
    connector.seed({ id: 'ev-1', title: 'Stand-up', start: futureDate(1), end: futureDate(1, 1), etag: 'e1' });
    connector.seed({ id: 'ev-2', title: 'Planning', start: futureDate(2), end: futureDate(2, 1), etag: 'e2' });

    await sync(connector);
    expect(meetingBlocks()).toHaveLength(2);
    expect(externalRows('inbound')).toHaveLength(2);

    // Second cycle — same events, unchanged etags. No duplicates created.
    await sync(connector);
    expect(meetingBlocks()).toHaveLength(2);
    expect(externalRows('inbound')).toHaveLength(2);
  });

  // ── I9 ──────────────────────────────────────────────────────────────────────

  it('I9: a CP-pushed outbound event is not re-mirrored as an inbound meeting block', async () => {
    config.sync.writeback = true;
    try {
      const { id: blockId } = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
           VALUES (uuid7(), 'Focus block', 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
        )
        .get(futureDate(3), futureDate(3, 2), SYSTEM_OWNER) as { id: string };
      sqlite
        .prepare(
          `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
           VALUES (uuid7(), ?, ?, 'google', 'primary')`,
        )
        .run(SYSTEM_OWNER, blockId);

      // First sync: block is pushed outbound → fixture now has the event.
      await sync(connector);
      expect(connector.size).toBe(1);
      expect(externalRows('outbound')).toHaveLength(1);
      expect(meetingBlocks()).toHaveLength(0); // no inbound mirror

      // Second sync: fixture returns our own event on the inbound page.
      // applyInbound sees direction='outbound' mapping → no-op (echo guard).
      await sync(connector);
      expect(meetingBlocks()).toHaveLength(0); // still no inbound mirror
      expect(externalRows('inbound')).toHaveLength(0);
    } finally {
      config.sync.writeback = false;
    }
  });

  // ── I8 ──────────────────────────────────────────────────────────────────────

  it('I8: existing inbound blocks survive a full re-init after cursor expiry', async () => {
    connector.seed({ id: 'ev-keep', title: 'Keep me', start: futureDate(5), end: futureDate(5, 1), etag: 'ek' });

    // First sync: full cycle creates the block and stores a sync cursor.
    await sync(connector);
    expect(meetingBlocks()).toHaveLength(1);

    // Corrupt the cursor so the connector treats it as unknown → expired.
    sqlite
      .prepare(
        `UPDATE sync_state SET cursor = 'invalid-token'
         WHERE provider = 'google' AND account = 'primary' AND resource = 'calendar_synctoken'`,
      )
      .run();

    // Clear fixture so the full re-init returns an empty event list.
    connector.clear();

    // Second sync: expired token → full re-init with no events.
    // I8: a full cycle must NOT delete existing inbound blocks on absence.
    await sync(connector);
    expect(meetingBlocks()).toHaveLength(1);
  });

  // ── I10 ─────────────────────────────────────────────────────────────────────

  it('I10: PATCH title on an inbound meeting block returns 422', async () => {
    connector.seed({ id: 'ev-ro', title: 'Read-only meeting', start: futureDate(1), end: futureDate(1, 1), etag: 'er' });
    await sync(connector);

    const [block] = meetingBlocks();
    expect(block).toBeDefined();

    const { status, body } = await api<{ error: string }>(
      server.url,
      `/api/blocks/${block.id}`,
      { method: 'PATCH', json: { title: 'Overwrite attempt' } },
    );

    expect(status).toBe(422);
    expect(body.error).toContain('read-only');
  });

  it('I10: PATCH start_at on an inbound meeting block returns 422', async () => {
    connector.seed({ id: 'ev-ro2', title: 'Meeting', start: futureDate(2), end: futureDate(2, 1), etag: 'er2' });
    await sync(connector);

    const [block] = meetingBlocks();
    const { status } = await api(server.url, `/api/blocks/${block.id}`, {
      method: 'PATCH',
      json: { start_at: futureDate(3) },
    });
    expect(status).toBe(422);
  });

  it('I10: PATCH non-time fields on an inbound meeting block succeeds', async () => {
    connector.seed({ id: 'ev-ro3', title: 'Meeting', start: futureDate(2), end: futureDate(2, 1), etag: 'er3' });
    await sync(connector);

    const [block] = meetingBlocks();
    const { status } = await api(server.url, `/api/blocks/${block.id}`, {
      method: 'PATCH',
      json: { status: 'completed' },
    });
    expect(status).toBe(200);
  });

  // ── I7 ──────────────────────────────────────────────────────────────────────

  it('I7: re-queuing an already-mapped outbound block calls updateEvent, not a duplicate createEvent', async () => {
    config.sync.writeback = true;
    try {
      const { id: blockId } = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
           VALUES (uuid7(), 'Task A', 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
        )
        .get(futureDate(2), futureDate(2, 1), SYSTEM_OWNER) as { id: string };
      sqlite
        .prepare(
          `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
           VALUES (uuid7(), ?, ?, 'google', 'primary')`,
        )
        .run(SYSTEM_OWNER, blockId);

      // First sync: creates one remote event.
      await sync(connector);
      expect(connector.size).toBe(1);
      expect(externalRows('outbound')).toHaveLength(1);

      // Re-queue (simulates crash between push and queue-clear, or a second PATCH).
      sqlite
        .prepare(
          `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
           VALUES (uuid7(), ?, ?, 'google', 'primary')
           ON CONFLICT(block_id, provider, account) DO UPDATE SET created_at = CURRENT_TIMESTAMP`,
        )
        .run(SYSTEM_OWNER, blockId);

      // Second sync: must call updateEvent on the existing mapping, not createEvent again.
      await sync(connector);
      expect(connector.size).toBe(1); // no duplicate remote event
      expect(externalRows('outbound')).toHaveLength(1); // one mapping, same block
    } finally {
      config.sync.writeback = false;
    }
  });
});
