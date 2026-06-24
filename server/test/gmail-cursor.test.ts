import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import type { GoogleClient, EmailMessage } from '../src/mcp/google.js';

// Control extraction per-message: the poison id throws a NON-transient (non-Ollama) error;
// everything else yields one task. This drives the dead-letter + watermark-advance paths
// deterministically without a live Ollama.
const POISON_ID = 'm-poison';
vi.mock('../src/agents/extract.js', () => ({
  extractTasks: vi.fn(async (source: { ref: string; subject?: string; text: string }) => {
    if (source.ref === POISON_ID) throw new Error('boom: malformed model output');
    return [
      {
        title: (source.subject ?? source.text).slice(0, 200) || 'Todo',
        summary: undefined,
        priority: 3,
        dueAt: null,
        estimatedMinutes: null,
        tags: [],
        confidence: 0.9,
      },
    ];
  }),
}));

import { ingestEmails } from '../src/agents/ingest.js';

const run = <T>(fn: () => Promise<T>) => runWithOwner(SYSTEM_OWNER, fn);

const ACCOUNT = 'primary';

function fakeClient(emails: EmailMessage[]): GoogleClient {
  return {
    mode: 'fixture',
    // Honor `since` so we can assert the watermark is actually applied.
    async listEmails(opts = {}) {
      let out = emails;
      if (opts.since) out = out.filter((e) => e.receivedAt > opts.since!);
      return out;
    },
    async listEvents() {
      return [];
    },
  };
}

function readCursor(resource: string) {
  return sqlite
    .prepare(
      `SELECT cursor FROM sync_state
       WHERE owner_id = ? AND provider = 'google' AND account = ? AND resource = ?`,
    )
    .get(SYSTEM_OWNER, ACCOUNT, resource) as { cursor: string | null } | undefined;
}

describe('gmail watermark cursor + dead-letter (WP5)', () => {
  beforeEach(() => {
    sqlite.exec(
      'DELETE FROM possible_task_tags; DELETE FROM possible_tasks; DELETE FROM tags; DELETE FROM sync_state;',
    );
  });

  it('advances the gmail_since watermark to the newest processed receivedAt', async () => {
    const client = fakeClient([
      { id: 'm-1', from: 'a@x.io', subject: 'First', body: 'do thing', receivedAt: '2026-06-01T10:00:00.000Z' },
      { id: 'm-2', from: 'b@x.io', subject: 'Second', body: 'do other thing', receivedAt: '2026-06-02T10:00:00.000Z' },
    ]);

    const r = await run(() => ingestEmails(client));

    expect(r.possiblesCreated).toBe(2);
    expect(readCursor('gmail_since')?.cursor).toBe('2026-06-02T10:00:00.000Z');
  });

  it('reads the persisted watermark and only processes newer messages on the next cycle', async () => {
    // Seed a watermark so m-1 is already past.
    sqlite
      .prepare(
        `INSERT INTO sync_state (id, owner_id, provider, account, resource, cursor)
         VALUES ('seed-since', ?, 'google', ?, 'gmail_since', '2026-06-01T10:00:00.000Z')`,
      )
      .run(SYSTEM_OWNER, ACCOUNT);

    const client = fakeClient([
      { id: 'm-1', from: 'a@x.io', subject: 'Old', body: 'old', receivedAt: '2026-06-01T10:00:00.000Z' },
      { id: 'm-2', from: 'b@x.io', subject: 'New', body: 'new', receivedAt: '2026-06-03T10:00:00.000Z' },
    ]);

    const r = await run(() => ingestEmails(client));

    // Only the newer message was seen (since-filter applied).
    expect(r.itemsProcessed).toBe(1);
    expect(r.possiblesCreated).toBe(1);
    expect(readCursor('gmail_since')?.cursor).toBe('2026-06-03T10:00:00.000Z');
  });

  it('dead-letters a poison message (queryable), continues, and still advances the watermark', async () => {
    const client = fakeClient([
      { id: 'm-1', from: 'a@x.io', subject: 'Good A', body: 'ok', receivedAt: '2026-06-01T10:00:00.000Z' },
      { id: POISON_ID, from: 'b@x.io', subject: 'Bad', body: 'explodes', receivedAt: '2026-06-02T10:00:00.000Z' },
      { id: 'm-3', from: 'c@x.io', subject: 'Good C', body: 'ok', receivedAt: '2026-06-03T10:00:00.000Z' },
    ]);

    const r = await run(() => ingestEmails(client));

    // The two healthy messages still produced possibles — the poison didn't wedge the batch.
    expect(r.possiblesCreated).toBe(2);

    // The poison id is recorded in the dead-letter list (queryable JSON array).
    const dl = readCursor('gmail_deadletter');
    expect(dl?.cursor).toBeTruthy();
    expect(JSON.parse(dl!.cursor!)).toContain(POISON_ID);

    // The watermark advanced PAST the poison message (not wedged, not lost forever).
    expect(readCursor('gmail_since')?.cursor).toBe('2026-06-03T10:00:00.000Z');
  });
});
