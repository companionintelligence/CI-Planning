import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
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

const run = <T>(fn: () => Promise<T>) => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);

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
    // AF-3: ingestEmails now auto-promotes its batch into tasks, and tasks carry the
    // partial UNIQUE(source_kind, source_ref) WHERE source_kind IN ('gmail','gcal')
    // (0027 ingest dedupe) — clear tasks (and their referencing tables) between tests
    // or re-ingesting the same message ids collides.
    sqlite.exec(
      'DELETE FROM possible_task_tags; DELETE FROM possible_tasks; DELETE FROM tags; DELETE FROM sync_state;'
      + 'DELETE FROM time_blocks; DELETE FROM flight_plan; DELETE FROM entity_tags; DELETE FROM tasks;',
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

    // AF-3: the batch auto-promoted at ingestion — nothing stays pending; every row is
    // settled ('promoted' or, when embeddings are live and titles collide, 'duplicate')
    // and each promoted row points at a real task.
    const rows = sqlite
      .prepare(`SELECT status, promoted_task_id FROM possible_tasks`)
      .all() as { status: string; promoted_task_id: string | null }[];
    expect(rows.length).toBe(2);
    expect(rows.every((x) => x.status !== 'pending')).toBe(true);
    for (const row of rows.filter((x) => x.status === 'promoted')) {
      expect(sqlite.prepare(`SELECT id FROM tasks WHERE id = ?`).get(row.promoted_task_id)).toBeDefined();
    }
    expect(r.promoted + r.duplicates).toBe(2);
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
    // AF-3: and both were settled at batch end (promoted, or duplicate under live embeddings).
    const pendingLeft = (sqlite.prepare(`SELECT COUNT(*) AS n FROM possible_tasks WHERE status = 'pending'`).get() as { n: number }).n;
    expect(pendingLeft).toBe(0);

    // The poison id is recorded in the dead-letter list (queryable JSON array).
    const dl = readCursor('gmail_deadletter');
    expect(dl?.cursor).toBeTruthy();
    expect(JSON.parse(dl!.cursor!)).toContain(POISON_ID);

    // The watermark advanced PAST the poison message (not wedged, not lost forever).
    expect(readCursor('gmail_since')?.cursor).toBe('2026-06-03T10:00:00.000Z');
  });
});
