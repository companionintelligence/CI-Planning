import { describe, it, expect, beforeEach } from 'vitest';
import { FixtureConnector } from '../src/connectors/fixture.js';
import { resetDb } from './helpers.js';

function futureDate(daysAhead: number, hourOffset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

describe('FixtureConnector — incremental sync simulation', () => {
  let connector: FixtureConnector;

  beforeEach(() => {
    resetDb();
    connector = new FixtureConnector('google', 'incr@example.com');
  });

  it('full cycle (no syncToken) returns all live events plus a nextSyncToken', async () => {
    connector.seed({ id: 'a', title: 'A', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    connector.seed({ id: 'b', title: 'B', start: futureDate(2), end: futureDate(2, 1), etag: 'v1' });

    const res = await connector.listEvents();
    expect(res.events.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(res.nextSyncToken).toBeTruthy();
    expect(res.expired).toBeFalsy();
  });

  it('incremental cycle returns only changed events plus a deleted:true tombstone', async () => {
    connector.seed({ id: 'a', title: 'A', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    connector.seed({ id: 'b', title: 'B', start: futureDate(2), end: futureDate(2, 1), etag: 'v1' });

    // Establish a baseline token after the two seeds.
    const full = await connector.listEvents();
    const token = full.nextSyncToken!;

    // Mutate: delete 'a', update 'b', create 'c'.
    await connector.deleteEvent('a', null);
    await connector.updateEvent('b', { title: 'B2', start: futureDate(2), end: futureDate(2, 1) }, null);
    const c = await connector.createEvent({ title: 'C', start: futureDate(3), end: futureDate(3, 1) });

    const incr = await connector.listEvents({ syncToken: token });
    const byId = new Map(incr.events.map((e) => [e.id, e]));

    // Deleted 'a' surfaces as a tombstone.
    expect(byId.get('a')).toMatchObject({ id: 'a', deleted: true });
    // Updated 'b' surfaces with the new title (no deleted flag).
    expect(byId.get('b')).toMatchObject({ id: 'b', title: 'B2' });
    expect(byId.get('b')!.deleted).toBeFalsy();
    // Newly created 'c' surfaces.
    expect(byId.get(c.id)).toBeDefined();
    expect(byId.get(c.id)!.deleted).toBeFalsy();
    // Advances the cursor.
    expect(incr.nextSyncToken).toBeTruthy();
    expect(incr.expired).toBeFalsy();
  });

  it('an incremental cycle with no changes returns an empty page (still has a token)', async () => {
    connector.seed({ id: 'a', title: 'A', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    const full = await connector.listEvents();
    const incr = await connector.listEvents({ syncToken: full.nextSyncToken! });
    expect(incr.events).toHaveLength(0);
    expect(incr.nextSyncToken).toBeTruthy();
    expect(incr.expired).toBeFalsy();
  });

  it('an unknown / too-old syncToken returns { expired: true } and no events', async () => {
    connector.seed({ id: 'a', title: 'A', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    const res = await connector.listEvents({ syncToken: 'totally-bogus-token' });
    expect(res.expired).toBe(true);
    expect(res.events).toHaveLength(0);
  });

  it('after expiry, a full re-init returns the live set again', async () => {
    connector.seed({ id: 'a', title: 'A', start: futureDate(1), end: futureDate(1, 1), etag: 'v1' });
    const expired = await connector.listEvents({ syncToken: 'bogus' });
    expect(expired.expired).toBe(true);

    const full = await connector.listEvents(); // caller re-inits with no token
    expect(full.events.map((e) => e.id)).toEqual(['a']);
    expect(full.nextSyncToken).toBeTruthy();
  });
});
