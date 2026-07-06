import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { FixtureConnector } from '../src/connectors/fixture.js';
import { syncConnector, syncAll, enqueueOutbound } from '../src/agents/sync.js';
import { config } from '../src/lib/config.js';
import { resetDb } from './helpers.js';

// All sync calls run inside SYSTEM_OWNER context (matches cron scheduler behavior).
const sync = (c: FixtureConnector) => runWithOwner(SYSTEM_OWNER, [], () => syncConnector(c));

// Return an ISO date N days from now at (09 + hourOffset):00 UTC.
// Stays inside the sync window (−7d to +30d) as long as daysAhead ≤ 29.
function futureDate(daysAhead: number, hourOffset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function externalEvents() {
  return sqlite.prepare('SELECT * FROM external_events').all() as Array<{
    id: string;
    external_id: string;
    block_id: string;
    etag: string | null;
    direction: string;
  }>;
}

function blocks() {
  return sqlite
    .prepare('SELECT id, title, start_at, end_at, is_locked FROM time_blocks')
    .all() as Array<{ id: string; title: string; start_at: string; end_at: string; is_locked: number }>;
}

function outboundQueue() {
  return sqlite.prepare('SELECT * FROM outbound_queue').all();
}

/** The persisted calendar incremental cursor for the sync-test connector, or undefined. */
function calendarCursor(): string | null | undefined {
  const row = sqlite
    .prepare(
      `SELECT cursor FROM sync_state
       WHERE provider = 'google' AND account = 'sync-test@example.com' AND resource = 'calendar_synctoken'`,
    )
    .get() as { cursor: string | null } | undefined;
  return row?.cursor;
}

describe('calendar sync — fixture mode (offline)', () => {
  let connector: FixtureConnector;

  beforeEach(() => {
    resetDb();
    connector = new FixtureConnector('google', 'sync-test@example.com');
  });

  // ── Inbound round-trips ────────────────────────────────────────────────────

  describe('inbound', () => {
    it('mirrors a new remote event as a locked meeting block', async () => {
      connector.seed({ id: 'evt-1', title: 'Team Standup', start: futureDate(1), end: futureDate(1, 1), etag: 'etag-v1' });

      const r = await sync(connector);

      expect(r.created).toBe(1);
      expect(r.updated).toBe(0);
      expect(r.deleted).toBe(0);
      expect(r.errors).toHaveLength(0);

      const [block] = blocks();
      expect(block.title).toBe('Team Standup');
      expect(block.is_locked).toBe(1);

      const [mapping] = externalEvents();
      expect(mapping.external_id).toBe('evt-1');
      expect(mapping.etag).toBe('etag-v1');
      expect(mapping.direction).toBe('inbound');
      expect(mapping.block_id).toBe(block.id);
    });

    it('updates a local block when the remote etag changes', async () => {
      connector.seed({ id: 'evt-1', title: 'Old Title', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
      await sync(connector);

      await connector.updateEvent('evt-1', { title: 'New Title', start: futureDate(2), end: futureDate(2, 1) }, null);
      const r = await sync(connector);

      expect(r.created).toBe(0);
      expect(r.updated).toBe(1);

      const [block] = blocks();
      expect(block.title).toBe('New Title');

      const [mapping] = externalEvents();
      expect(mapping.etag).toBe(connector.get('evt-1')!.etag);
    });

    it('is a no-op when the remote etag is unchanged (idempotent)', async () => {
      connector.seed({ id: 'evt-1', title: 'Standup', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
      await sync(connector);
      const titleBefore = blocks()[0]!.title;

      const r = await sync(connector);

      expect(r.created).toBe(0);
      expect(r.updated).toBe(0);
      expect(blocks()[0]!.title).toBe(titleBefore);
    });

    it('deletes the local block when the remote event is tombstoned on an incremental cycle', async () => {
      // I8: deletion is tombstone-driven, NOT absence-driven. The first sync is FULL (no
      // cursor) and persists a calendar_synctoken; deleting the event then re-syncing reads
      // that cursor → INCREMENTAL → the fixture returns a { deleted:true } tombstone, which
      // is what removes the local block.
      connector.seed({ id: 'evt-1', title: 'Gone', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
      await sync(connector);
      expect(blocks()).toHaveLength(1);
      expect(calendarCursor()).toBeTruthy(); // a cursor was persisted → next cycle is incremental

      await connector.deleteEvent('evt-1', null);
      const r = await sync(connector); // incremental: tombstone for evt-1

      expect(r.deleted).toBe(1);
      expect(blocks()).toHaveLength(0);
      expect(externalEvents()).toHaveLength(0);
    });

    it('I8: a FULL cycle does NOT delete an inbound block merely absent from the page', async () => {
      // Mirror an event, then wipe the persisted cursor so the next cycle is FULL again.
      connector.seed({ id: 'evt-1', title: 'Stays', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
      await sync(connector);
      expect(blocks()).toHaveLength(1);

      // Remove the event from the connector's LIVE set WITHOUT a tombstone visible to a full
      // listing, and force a full cycle by clearing the cursor. A full listing simply omits
      // the event (no deleted:true). I8 forbids treating that absence as a delete.
      await connector.deleteEvent('evt-1', null);
      sqlite
        .prepare(
          `DELETE FROM sync_state WHERE provider = 'google' AND account = 'sync-test@example.com'
             AND resource = 'calendar_synctoken'`,
        )
        .run();

      const r = await sync(connector); // FULL: evt-1 simply absent

      expect(r.deleted).toBe(0);
      expect(blocks()).toHaveLength(1); // the inbound block survives
      expect(externalEvents()).toHaveLength(1);
    });

    it('produces no duplicates or orphans after 3 sync cycles (steady state)', async () => {
      connector.seed({ id: 'evt-1', title: 'A', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
      connector.seed({ id: 'evt-2', title: 'B', start: futureDate(2), end: futureDate(2, 1), etag: 'v1' });

      await sync(connector);
      await sync(connector);
      const r3 = await sync(connector);

      expect(r3.created).toBe(0);
      expect(r3.updated).toBe(0);
      expect(blocks()).toHaveLength(2);
      expect(externalEvents()).toHaveLength(2);
    });

    it('leaves no orphans over an appear → change → disappear lifecycle across 3 cycles', async () => {
      // Cycle 1: event appears
      connector.seed({ id: 'evt-1', title: 'Ephemeral', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
      await sync(connector);
      expect(blocks()).toHaveLength(1);

      // Cycle 2: event title changes
      await connector.updateEvent('evt-1', { title: 'Renamed', start: futureDate(1), end: futureDate(1, 1) }, null);
      await sync(connector);
      expect(blocks()[0]!.title).toBe('Renamed');
      expect(externalEvents()).toHaveLength(1);

      // Cycle 3: event removed remotely. Cycles 1+2 each persisted a cursor, so this cycle
      // is INCREMENTAL and the delete arrives as a tombstone (I8: not absence-driven).
      await connector.deleteEvent('evt-1', null);
      const r = await sync(connector);
      expect(r.deleted).toBe(1);
      expect(blocks()).toHaveLength(0);
      expect(externalEvents()).toHaveLength(0);
    });

    it('syncs multiple independent events without cross-contamination', async () => {
      for (let i = 1; i <= 5; i++) {
        connector.seed({ id: `multi-${i}`, title: `Meeting ${i}`, start: futureDate(i), end: futureDate(i, 1), etag: `v${i}` });
      }
      const r = await sync(connector);

      expect(r.created).toBe(5);
      expect(blocks()).toHaveLength(5);
      expect(externalEvents()).toHaveLength(5);

      // Update one event — only that block should change
      await connector.updateEvent('multi-3', { title: 'Changed', start: futureDate(3), end: futureDate(3, 1) }, null);
      const r2 = await sync(connector);

      expect(r2.updated).toBe(1);
      expect(blocks().find((b) => b.title === 'Changed')).toBeDefined();
      expect(blocks().filter((b) => b.title !== 'Changed')).toHaveLength(4);
    });
  });

  // ── Outbound push ──────────────────────────────────────────────────────────

  describe('outbound', () => {
    // Outbound path is gated by CP_SYNC_WRITEBACK (off by default). Enable it for
    // this group only; restore after each test so other suites are unaffected.
    beforeEach(() => { config.sync.writeback = true; });
    afterEach(() => { config.sync.writeback = false; });

    it('creates a remote event for a queued block and clears the queue', async () => {
      const { id: blockId } = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
           VALUES (uuid7(), 'Project Planning', 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
        )
        .get(futureDate(3), futureDate(3, 2), SYSTEM_OWNER) as { id: string };
      sqlite
        .prepare(
          `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
           VALUES (uuid7(), ?, ?, 'google', 'sync-test@example.com')`,
        )
        .run(SYSTEM_OWNER, blockId);

      const r = await sync(connector);

      expect(r.created).toBe(1);
      expect(r.errors).toHaveLength(0);
      expect(outboundQueue()).toHaveLength(0);

      const [mapping] = externalEvents().filter((e) => e.direction === 'outbound');
      expect(mapping).toBeDefined();
      expect(mapping.external_id).toMatch(/^fixture-/);
      expect(connector.get(mapping.external_id)?.title).toBe('Project Planning');
    });

    it('updates the remote event when a re-queued block already has a mapping', async () => {
      const { id: blockId } = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
           VALUES (uuid7(), 'Original', 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
        )
        .get(futureDate(3), futureDate(3, 2), SYSTEM_OWNER) as { id: string };
      sqlite
        .prepare(
          `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
           VALUES (uuid7(), ?, ?, 'google', 'sync-test@example.com')`,
        )
        .run(SYSTEM_OWNER, blockId);
      await sync(connector);

      const [firstMapping] = externalEvents().filter((e) => e.direction === 'outbound');
      const externalId = firstMapping.external_id;

      // Simulate PATCH /api/blocks/:id: update + re-enqueue
      sqlite.prepare('UPDATE time_blocks SET title = ? WHERE id = ?').run('Updated', blockId);
      sqlite
        .prepare(
          `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
           VALUES (uuid7(), ?, ?, 'google', 'sync-test@example.com')
           ON CONFLICT(block_id, provider, account) DO UPDATE SET created_at = CURRENT_TIMESTAMP`,
        )
        .run(SYSTEM_OWNER, blockId);
      const r = await sync(connector);

      expect(r.updated).toBe(1);
      expect(r.created).toBe(0);
      expect(outboundQueue()).toHaveLength(0);
      expect(connector.get(externalId)?.title).toBe('Updated');
    });

    it('resolves an etag conflict as remote-wins and clears the queue', async () => {
      const remote = await connector.createEvent({ title: 'Remote Version', start: futureDate(3), end: futureDate(3, 2) });

      const { id: blockId } = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
           VALUES (uuid7(), 'Local Version', 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
        )
        .get(futureDate(3), futureDate(3, 2), SYSTEM_OWNER) as { id: string };
      // Map to remote but with a stale etag
      sqlite
        .prepare(
          `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id, etag, direction, last_synced_at)
           VALUES (uuid7(), ?, 'google', 'sync-test@example.com', ?, ?, 'stale-etag', 'outbound', datetime('now'))`,
        )
        .run(SYSTEM_OWNER, remote.id, blockId);
      sqlite
        .prepare(
          `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
           VALUES (uuid7(), ?, ?, 'google', 'sync-test@example.com')`,
        )
        .run(SYSTEM_OWNER, blockId);

      const r = await sync(connector);

      expect(r.conflicts).toBe(1);
      expect(r.errors).toHaveLength(0);
      // Queue cleared even on conflict (not retried with the same stale data)
      expect(outboundQueue()).toHaveLength(0);
      // etag in external_events updated to the remote's actual etag
      const [mapping] = externalEvents().filter((e) => e.direction === 'outbound');
      expect(mapping.etag).toBe(remote.etag);
      expect(mapping.etag).not.toBe('stale-etag');
    });
  });

  // ── SyncResult shape ───────────────────────────────────────────────────────

  describe('SyncResult', () => {
    it('returns a well-formed result for an empty remote', async () => {
      const r = await sync(connector);
      expect(r.provider).toBe('google');
      expect(r.account).toBe('sync-test@example.com');
      expect(r.created).toBe(0);
      expect(r.updated).toBe(0);
      expect(r.deleted).toBe(0);
      expect(r.conflicts).toBe(0);
      expect(r.errors).toHaveLength(0);
    });

    it('counts mixed inbound + outbound operations correctly', async () => {
      config.sync.writeback = true;
      // Two inbound events
      connector.seed({ id: 'in-1', title: 'Meeting A', start: futureDate(1), end: futureDate(1, 1), etag: 'ea' });
      connector.seed({ id: 'in-2', title: 'Meeting B', start: futureDate(2), end: futureDate(2, 1), etag: 'eb' });
      // One outbound block to push
      const { id: blockId } = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
           VALUES (uuid7(), 'Task Block', 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
        )
        .get(futureDate(5), futureDate(5, 1), SYSTEM_OWNER) as { id: string };
      sqlite
        .prepare(`INSERT INTO outbound_queue (id, owner_id, block_id, provider, account) VALUES (uuid7(), ?, ?, 'google', 'sync-test@example.com')`)
        .run(SYSTEM_OWNER, blockId);

      const r = await sync(connector);

      expect(r.created).toBe(3); // 2 inbound + 1 outbound (createEvent)
      expect(r.updated).toBe(0);
      expect(r.deleted).toBe(0);
      expect(r.errors).toHaveLength(0);
      config.sync.writeback = false;
    });
  });

  // ── CP_SYNC_DISABLED master kill switch (Phase Y wiring) ────────────────────

  describe('CP_SYNC_DISABLED kill switch', () => {
    afterEach(() => {
      config.sync.disabled = false;
      config.sync.writeback = false;
    });

    it('syncConnector does no inbound work when sync is disabled', async () => {
      connector.seed({ id: 'evt-1', title: 'Should not mirror', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
      config.sync.disabled = true;

      const r = await sync(connector);

      expect(r.created).toBe(0);
      expect(r.updated).toBe(0);
      expect(r.deleted).toBe(0);
      expect(blocks()).toHaveLength(0);
      expect(externalEvents()).toHaveLength(0);
    });

    it('syncConnector leaves the outbound queue untouched when disabled (even with writeback on)', async () => {
      config.sync.writeback = true;
      const { id: blockId } = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
           VALUES (uuid7(), 'Queued', 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
        )
        .get(futureDate(3), futureDate(3, 1), SYSTEM_OWNER) as { id: string };
      sqlite
        .prepare(
          `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
           VALUES (uuid7(), ?, ?, 'google', 'sync-test@example.com')`,
        )
        .run(SYSTEM_OWNER, blockId);
      config.sync.disabled = true;

      const r = await sync(connector);

      expect(r.created).toBe(0);
      expect(r.updated).toBe(0);
      expect(outboundQueue()).toHaveLength(1); // still pending — never pushed
      expect(externalEvents().filter((e) => e.direction === 'outbound')).toHaveLength(0);
    });

    it('enqueueOutbound queues nothing when disabled, even with writeback on + an active connector', () => {
      // Seed an ACTIVE connector so enqueueOutbound WOULD queue when enabled (distinguishing control).
      sqlite
        .prepare(
          `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version, status)
           VALUES (uuid7(), ?, 'google', 'sync-test@example.com', 'aa', 'bb', 'cc', 1, 'active')`,
        )
        .run(SYSTEM_OWNER);
      const { id: blockId } = sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
           VALUES (uuid7(), 'X', 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
        )
        .get(futureDate(3), futureDate(3, 1), SYSTEM_OWNER) as { id: string };
      config.sync.writeback = true;

      // Control: enabled → the block is queued for the active connector.
      runWithOwner(SYSTEM_OWNER, [], () => enqueueOutbound(blockId));
      expect(outboundQueue()).toHaveLength(1);

      // Kill switch: disabled → a fresh enqueue adds nothing.
      sqlite.prepare('DELETE FROM outbound_queue').run();
      config.sync.disabled = true;
      runWithOwner(SYSTEM_OWNER, [], () => enqueueOutbound(blockId));
      expect(outboundQueue()).toHaveLength(0);
    });

    it('syncAll short-circuits to [] before touching connectors when disabled', async () => {
      // Seed an ACTIVE google token so getConnectors() would otherwise return a live connector;
      // the disabled gate must return [] before that (no getConnectors, no network sync attempt).
      sqlite
        .prepare(
          `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version, status)
           VALUES (uuid7(), ?, 'google', 'sync-test@example.com', 'aa', 'bb', 'cc', 1, 'active')`,
        )
        .run(SYSTEM_OWNER);
      config.sync.disabled = true;

      const results = await runWithOwner(SYSTEM_OWNER, [], () => syncAll());
      expect(results).toEqual([]);
    });
  });

  // ── EtagConflictError from FixtureConnector ────────────────────────────────

  describe('EtagConflictError (fixture)', () => {
    it('FixtureConnector throws on updateEvent with wrong ifMatch', async () => {
      const event = await connector.createEvent({ title: 'X', start: futureDate(1), end: futureDate(1, 1) });
      await expect(connector.updateEvent(event.id, { title: 'Y', start: futureDate(1), end: futureDate(1, 1) }, 'wrong-etag'))
        .rejects
        .toThrow('Etag conflict');
    });

    it('FixtureConnector allows updateEvent with null ifMatch (force update)', async () => {
      const event = await connector.createEvent({ title: 'X', start: futureDate(1), end: futureDate(1, 1) });
      const updated = await connector.updateEvent(event.id, { title: 'Y', start: futureDate(1), end: futureDate(1, 1) }, null);
      expect(updated.title).toBe('Y');
    });

    it('FixtureConnector deleteEvent is idempotent when event already gone', async () => {
      await connector.createEvent({ title: 'X', start: futureDate(1), end: futureDate(1, 1) });
      await connector.deleteEvent('fixture-1', null);
      await expect(connector.deleteEvent('fixture-1', null)).resolves.toBeUndefined();
    });
  });
});
