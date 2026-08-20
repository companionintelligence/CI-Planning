import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import type { GoogleClient, EmailMessage } from '../src/mcp/google.js';

/**
 * Ingest is BOUNDED and does not lose extractions to an Ollama outage.
 *
 * Two defects motivated this file, both on the ingest fan-out:
 *
 *  1. The scheduled callers passed no limit, so one run issued a quality-tier extraction
 *     (60s ceiling) per message with nothing capping the count — a freshly-connected
 *     mailbox meant an unbounded serial fan-out of the most expensive call the app makes.
 *
 *  2. When Ollama was unreachable, every message was staged as a title-only `fallbackTask`
 *     stub AND the watermark advanced past it. The stub is permanent and nothing re-reads
 *     a message behind the cursor, so an outage silently destroyed the real extraction for
 *     a whole batch — and reported success.
 *
 * The extractor is stubbed per-test (never a live model), same idiom as
 * ingest-windows.test.ts / gmail-cursor.test.ts, and hoisted above the ingest import.
 */
const extractMock = vi.hoisted(() => ({
  impl: null as null | ((source: { subject?: string; text: string }) => Promise<unknown>),
}));

vi.mock('../src/agents/extract.js', () => ({
  extractTasks: vi.fn(async (source: { subject?: string; text: string }) => {
    if (extractMock.impl) return extractMock.impl(source);
    return [{
      title: (source.subject ?? source.text).slice(0, 200) || 'Todo',
      summary: undefined, priority: 3, dueAt: null,
      estimatedMinutes: null, tags: [], confidence: 0.9,
    }];
  }),
}));

import { ingestEmails } from '../src/agents/ingest.js';
import { OllamaUnavailable, LlmParseError } from '../src/mcp/ollama.js';
import { resetDb } from './helpers.js';

const OWNER = SYSTEM_OWNER;
const ACCOUNT = 'primary';
const run = <T,>(fn: () => T | Promise<T>) => runWithOwner(OWNER, ALL_SCOPES, fn);

const readCursor = () =>
  (sqlite
    .prepare(
      `SELECT cursor FROM sync_state
        WHERE owner_id = ? AND provider = 'google' AND account = ? AND resource = 'gmail_since'`,
    )
    .get(OWNER, ACCOUNT) as { cursor: string | null } | undefined)?.cursor ?? null;

const possibleTitles = () =>
  (sqlite
    .prepare(`SELECT raw_title FROM possible_tasks WHERE proposed_owner_id = ? ORDER BY raw_title`)
    .all(OWNER) as { raw_title: string }[]).map((r) => r.raw_title);

/**
 * N messages, returned NEWEST FIRST — the order Gmail's own API uses, and the thing the
 * oldest-first sort has to defend against.
 *
 * Timestamps are relative to now and an hour apart: `email_lookback_days` defaults to 7,
 * so fixed calendar dates would fall behind the floor and be filtered out before ingest
 * ever saw them. Subjects are zero-padded so a lexicographic sort in the assertions
 * matches chronological order.
 */
function messages(n: number): EmailMessage[] {
  const base = Date.now() - (n + 1) * 3_600_000; // n hours back, well inside the 7-day floor
  const ascending = Array.from({ length: n }, (_, i) => ({
    id: `m${String(i + 1).padStart(3, '0')}`,
    subject: `Message ${String(i + 1).padStart(3, '0')}`,
    from: 'someone@example.com',
    body: `Body of message ${i + 1}`,
    receivedAt: new Date(base + i * 3_600_000).toISOString(),
  }));
  return ascending.reverse() as EmailMessage[];
}

function fakeClient(emails: EmailMessage[]): GoogleClient {
  return {
    mode: 'fixture',
    async listEmails(opts = {}) {
      return opts.since ? emails.filter((e) => e.receivedAt > opts.since!) : emails;
    },
    async listEvents() { return []; },
    async close() {},
  } as GoogleClient;
}

beforeEach(() => {
  resetDb();
  extractMock.impl = null;
});

describe('ingest batch bounds', () => {
  it('caps how many items one run puts through the model', async () => {
    const r = await run(() => ingestEmails(fakeClient(messages(120)), { maxExtractions: 10 }));
    expect(r.itemsProcessed).toBe(10);
  });

  it('takes the OLDEST first, so a capped run cannot skip past unread mail', async () => {
    // The client hands them back newest-first (as Gmail does). If the batch were taken
    // in that order, the cap would bank the newest and the watermark would jump to the
    // top — permanently orphaning everything older. The cursor must land on the 3rd
    // OLDEST message, not the newest.
    const all = messages(10);
    await run(() => ingestEmails(fakeClient(all), { maxExtractions: 3 }));

    const oldestThree = [...all].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(0, 3);
    expect(possibleTitles()).toEqual(oldestThree.map((m) => m.subject).sort());
    expect(readCursor()).toBe(oldestThree[2].receivedAt);
  });

  it('drains the remainder on the next run', async () => {
    const all = messages(5);
    const client = fakeClient(all);
    const first = await run(() => ingestEmails(client, { maxExtractions: 3 }));
    const second = await run(() => ingestEmails(client, { maxExtractions: 3 }));
    expect(first.itemsProcessed).toBe(3);
    expect(second.itemsProcessed).toBe(2); // the watermark carried the position across
    expect(possibleTitles()).toHaveLength(5);
  });
});

describe('ingest when Ollama is unreachable', () => {
  it('stages nothing, holds the watermark, and reports the items as deferred', async () => {
    extractMock.impl = async () => { throw new OllamaUnavailable('connect ECONNREFUSED'); };

    const r = await run(() => ingestEmails(fakeClient(messages(5))));

    // No title-only stubs were written…
    expect(possibleTitles()).toEqual([]);
    expect(r.itemsProcessed).toBe(0);
    // …the whole batch is accounted for as "not yet"…
    expect(r.deferred).toBe(5);
    // …and the cursor did NOT move, so these messages are still in the queue.
    expect(readCursor()).toBeNull();
  });

  it('halts at the first outage instead of paying a timeout per remaining message', async () => {
    let calls = 0;
    extractMock.impl = async () => {
      calls++;
      throw new OllamaUnavailable('connect ECONNREFUSED');
    };
    await run(() => ingestEmails(fakeClient(messages(20))));
    // One attempt tells us Ollama is down; 19 more would cost a full extract timeout each
    // to learn the same thing.
    expect(calls).toBe(1);
  });

  it('re-extracts the deferred messages once Ollama is back', async () => {
    const all = messages(3);
    const client = fakeClient(all);

    extractMock.impl = async () => { throw new OllamaUnavailable('connect ECONNREFUSED'); };
    await run(() => ingestEmails(client));
    expect(possibleTitles()).toEqual([]);

    extractMock.impl = null; // Ollama returns
    const recovered = await run(() => ingestEmails(client));
    expect(recovered.itemsProcessed).toBe(3);
    expect(possibleTitles()).toEqual(all.map((m) => m.subject).sort());
  });
});

describe('ingest when the model answers badly', () => {
  it('still stages the raw fallback and moves on — that IS this item\'s answer', async () => {
    // A parse failure is a model-quality outcome, not a transport one: re-asking just
    // rolls the same dice, so the stub is the honest permanent record and the batch
    // must NOT halt on it.
    extractMock.impl = async () => { throw new LlmParseError('no JSON in reply'); };

    const all = messages(3);
    const r = await run(() => ingestEmails(fakeClient(all)));

    expect(r.itemsProcessed).toBe(3);
    expect(r.deferred).toBe(0);
    expect(possibleTitles()).toEqual(all.map((m) => m.subject).sort());
    // And the cursor advanced, because these items are done.
    expect(readCursor()).toBe([...all].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).at(-1)!.receivedAt);
  });
});
