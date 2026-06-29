/**
 * Phase L §5: SSE catch-up integration tests.
 *
 * Verifies that a reconnecting client:
 *  - receives missed events when gap ≤ REPLAY_LIMIT
 *  - receives sync:resync with a correct id: line when gap > REPLAY_LIMIT,
 *    so the client cursor advances and the reconnect loop is broken (gap #8 fix)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, type TestServer } from './helpers.js';

const REPLAY_LIMIT = 500; // must match sse.ts

/**
 * Open an SSE connection with the given lastEventId cursor, read until the
 * server writes ':ok' (which always comes last in the preamble), then cancel.
 * Returns all text received before the connection is cancelled.
 */
async function readSsePreamble(url: string, lastEventId: number): Promise<string> {
  const res = await fetch(`${url}/api/events?lastEventId=${lastEventId}`, {
    headers: { Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(5000),
  });
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      const text = Buffer.concat(chunks).toString();
      // ':ok\n\n' is always the last thing written in the preamble phase.
      if (text.includes(':ok')) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).toString();
}

/**
 * Insert `count` rows into sync_events for SYSTEM_OWNER.
 * Returns the seq of the LAST inserted row.
 */
function seedSyncEvents(count: number): number {
  const insert = sqlite.prepare(
    `INSERT INTO sync_events (owner_id, entity, entity_id, version, event, payload, at)
     VALUES (?, 'task', 'fake-id', 1, 'task:updated', '{}', datetime('now'))`,
  );
  let lastSeq = 0;
  sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      const { lastInsertRowid } = insert.run(SYSTEM_OWNER);
      lastSeq = Number(lastInsertRowid);
    }
  })();
  return lastSeq;
}

describe('SSE catch-up', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => {
    resetDb();
    sqlite.exec(`DELETE FROM sync_events`);
  });

  it('replays missed events when gap ≤ REPLAY_LIMIT', async () => {
    // Client "saw" the first event, then 3 more arrived while it was offline.
    const seenSeq = seedSyncEvents(1);
    seedSyncEvents(3);

    const text = await readSsePreamble(server.url, seenSeq);
    expect(text).toContain('event: task:updated');
    expect(text).not.toContain('event: sync:resync');
    expect(text).toContain(':ok');
  });

  it('emits sync:resync with id: <maxSeq> when gap > REPLAY_LIMIT', async () => {
    // Client saw one event, then REPLAY_LIMIT+1 more arrived — too many to replay.
    const seenSeq = seedSyncEvents(1);
    const maxSeq = seedSyncEvents(REPLAY_LIMIT + 1);

    const text = await readSsePreamble(server.url, seenSeq);

    // Must trigger a resync, not individual event replay.
    expect(text).toContain('event: sync:resync');
    expect(text).not.toContain('event: task:updated');

    // id: <maxSeq> must be present so the browser cursor advances past the
    // overflow point — this is the gap #8 fix. Without it, every reconnect
    // would re-trigger the overflow and the client would loop forever.
    expect(text).toContain(`id: ${maxSeq}`);
  });

  it('sends no replay frames when lastEventId is current', async () => {
    const maxSeq = seedSyncEvents(5);

    const text = await readSsePreamble(server.url, maxSeq);
    expect(text).not.toContain('event: task:updated');
    expect(text).not.toContain('event: sync:resync');
    expect(text).toContain(':ok');
  });
});
