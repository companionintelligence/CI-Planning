import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { FixtureConnector } from '../src/connectors/fixture.js';
import { syncConnector } from '../src/agents/sync.js';
import { resetDb } from './helpers.js';

const sync = (c: FixtureConnector) => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => syncConnector(c));

function futureDate(daysAhead: number, hourOffset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function blocks() {
  return sqlite.prepare('SELECT id, title, source_ref FROM time_blocks').all() as Array<{
    id: string;
    title: string;
    source_ref: string;
  }>;
}

function inboundMappings() {
  return sqlite
    .prepare("SELECT external_id, block_id FROM external_events WHERE direction = 'inbound'")
    .all() as Array<{ external_id: string; block_id: string }>;
}

function cursorRow(provider: string, account: string) {
  return sqlite
    .prepare(
      `SELECT cursor FROM sync_state
       WHERE owner_id = ? AND provider = ? AND account = ? AND resource = 'calendar_synctoken'`,
    )
    .get(SYSTEM_OWNER, provider, account) as { cursor: string | null } | undefined;
}

describe('calendar incremental sync + cursors (WP5)', () => {
  let connector: FixtureConnector;

  beforeEach(() => {
    resetDb();
    connector = new FixtureConnector('google', 'incr-sync@example.com');
  });

  it('(a) first cycle with no cursor is FULL, persists a calendar_synctoken row, created>0', async () => {
    connector.seed({ id: 'evt-1', title: 'Standup', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    connector.seed({ id: 'evt-2', title: 'Review', start: futureDate(2), end: futureDate(2, 1), etag: 'v1' });

    const r = await sync(connector);

    expect(r.created).toBe(2);
    expect(r.errors).toHaveLength(0);
    expect(blocks()).toHaveLength(2);

    const row = cursorRow('google', 'incr-sync@example.com');
    expect(row?.cursor).toBeTruthy();
    expect(row!.cursor).toMatch(/^fixtok-v/);
  });

  it('(b) second cycle reads the stored cursor and calls listEvents incrementally', async () => {
    connector.seed({ id: 'evt-1', title: 'Standup', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    await sync(connector); // FULL — persists a cursor

    const spy = vi.spyOn(connector, 'listEvents');
    await sync(connector); // should be INCREMENTAL

    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0];
    expect(arg).toMatchObject({ syncToken: expect.stringMatching(/^fixtok-v/) });
    expect(arg).not.toHaveProperty('from'); // incremental, not a windowed full list
    spy.mockRestore();
  });

  it('(c) deleting an event then an incremental sync deletes that block+mapping (tombstone-driven); siblings untouched', async () => {
    connector.seed({ id: 'keep', title: 'Keep me', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    connector.seed({ id: 'drop', title: 'Drop me', start: futureDate(2), end: futureDate(2, 1), etag: 'v1' });
    await sync(connector); // FULL: both mirrored
    expect(blocks()).toHaveLength(2);

    await connector.deleteEvent('drop', null);
    const r = await sync(connector); // INCREMENTAL: tombstone for 'drop'

    expect(r.deleted).toBe(1);
    const remaining = blocks();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.source_ref).toBe('keep');
    // Mapping cascaded away with the block.
    expect(inboundMappings().map((m) => m.external_id)).toEqual(['keep']);
  });

  it('(d) I8: a FULL re-init (expired token) leaves existing inbound blocks intact (deleted===0)', async () => {
    connector.seed({ id: 'evt-1', title: 'Standup', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    connector.seed({ id: 'evt-2', title: 'Review', start: futureDate(2), end: futureDate(2, 1), etag: 'v1' });
    await sync(connector); // FULL — both mirrored, cursor stored
    expect(blocks()).toHaveLength(2);

    // Corrupt the stored cursor so the next incremental list reports { expired:true } and the
    // reconciler re-inits FULL. The fixture still serves both live events, so nothing should
    // be deleted — proving a full cycle never runs an absence-based delete sweep.
    sqlite
      .prepare(
        `UPDATE sync_state SET cursor = 'stale-bogus-token'
         WHERE owner_id = ? AND provider = 'google' AND account = 'incr-sync@example.com'
           AND resource = 'calendar_synctoken'`,
      )
      .run(SYSTEM_OWNER);

    const r = await sync(connector);

    expect(r.deleted).toBe(0);
    expect(blocks()).toHaveLength(2);
    expect(inboundMappings()).toHaveLength(2);
  });

  it('(e) an expired token clears the cursor, re-lists FULL, persists a fresh token, no throw', async () => {
    connector.seed({ id: 'evt-1', title: 'Standup', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    await sync(connector);

    const before = cursorRow('google', 'incr-sync@example.com')!.cursor;
    // Force the stored cursor to an unknown token → provider reports expired.
    sqlite
      .prepare(
        `UPDATE sync_state SET cursor = 'totally-unknown'
         WHERE owner_id = ? AND provider = 'google' AND account = 'incr-sync@example.com'
           AND resource = 'calendar_synctoken'`,
      )
      .run(SYSTEM_OWNER);

    // Add a fresh event so the full re-init mints a NEW token (version bumped).
    connector.seed({ id: 'evt-2', title: 'New', start: futureDate(3), end: futureDate(3, 1), etag: 'v1' });

    const r = await sync(connector);

    expect(r.errors).toHaveLength(0);
    const after = cursorRow('google', 'incr-sync@example.com');
    expect(after?.cursor).toBeTruthy();
    expect(after!.cursor).toMatch(/^fixtok-v/);
    expect(after!.cursor).not.toBe('totally-unknown');
    expect(after!.cursor).not.toBe(before); // a fresh token was minted on re-init
    // Both events are now mirrored after the full re-init.
    expect(blocks()).toHaveLength(2);
  });
});
