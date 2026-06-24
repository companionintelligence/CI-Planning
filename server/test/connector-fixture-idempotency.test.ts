import { describe, it, expect, beforeEach } from 'vitest';
import { FixtureConnector } from '../src/connectors/fixture.js';
import { resetDb } from './helpers.js';

function futureDate(daysAhead: number, hourOffset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

describe('FixtureConnector — createEvent idempotency', () => {
  let connector: FixtureConnector;

  beforeEach(() => {
    resetDb();
    connector = new FixtureConnector('google', 'idem@example.com');
  });

  it('returns the same event for a repeated idempotencyKey (no new id, size unchanged)', async () => {
    const input = { title: 'A', start: futureDate(1), end: futureDate(1, 1), idempotencyKey: 'block-1' };
    const first = await connector.createEvent(input);
    expect(connector.size).toBe(1);

    const second = await connector.createEvent(input);
    expect(second.id).toBe(first.id);
    expect(second.etag).toBe(first.etag);
    expect(connector.size).toBe(1); // no duplicate created
  });

  it('two distinct keys create two events', async () => {
    const a = await connector.createEvent({ title: 'A', start: futureDate(1), end: futureDate(1, 1), idempotencyKey: 'block-1' });
    const b = await connector.createEvent({ title: 'B', start: futureDate(2), end: futureDate(2, 1), idempotencyKey: 'block-2' });
    expect(a.id).not.toBe(b.id);
    expect(connector.size).toBe(2);
  });

  it('no key → sequential fixture-N ids', async () => {
    const a = await connector.createEvent({ title: 'A', start: futureDate(1), end: futureDate(1, 1) });
    const b = await connector.createEvent({ title: 'B', start: futureDate(2), end: futureDate(2, 1) });
    expect(a.id).toBe('fixture-1');
    expect(b.id).toBe('fixture-2');
    expect(connector.size).toBe(2);
  });

  it('does not expose idempotencyKey on the returned RemoteEvent', async () => {
    const e = await connector.createEvent({ title: 'A', start: futureDate(1), end: futureDate(1, 1), idempotencyKey: 'block-1' });
    expect((e as Record<string, unknown>).idempotencyKey).toBeUndefined();
  });
});
