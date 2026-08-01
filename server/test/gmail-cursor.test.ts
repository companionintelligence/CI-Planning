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

/**
 * Message times are RELATIVE to now, not fixed ISO strings. `email_lookback_days` (0147)
 * floors the ingest window at now−N days, so a hardcoded date would silently age past the
 * floor and make every one of these tests read zero messages — the repo's time-bomb-date
 * gotcha, the same reason the memory fixture uses `now±Nh`. Everything here sits inside
 * the 7-day default window; the floor itself is covered in email-lookback.test.ts.
 */
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const T1 = hoursAgo(72);
const T2 = hoursAgo(48);
const T3 = hoursAgo(24);

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
    // ingestEmails no longer promotes (email is review-gated), but the manual-approve
    // path in other tests still creates tasks carrying the partial
    // UNIQUE(source_kind, source_ref) WHERE source_kind IN ('gmail','gcal') (0027) —
    // clear tasks (and their referencing tables) between tests regardless.
    sqlite.exec(
      'DELETE FROM possible_task_tags; DELETE FROM possible_tasks; DELETE FROM tags; DELETE FROM sync_state;'
      + 'DELETE FROM time_blocks; DELETE FROM flight_plan; DELETE FROM entity_tags; DELETE FROM tasks;',
    );
  });

  it('advances the gmail_since watermark to the newest processed receivedAt', async () => {
    const client = fakeClient([
      { id: 'm-1', from: 'a@x.io', subject: 'First', body: 'do thing', receivedAt: T1 },
      { id: 'm-2', from: 'b@x.io', subject: 'Second', body: 'do other thing', receivedAt: T2 },
    ]);

    const r = await run(() => ingestEmails(client));

    expect(r.possiblesCreated).toBe(2);
    expect(readCursor('gmail_since')?.cursor).toBe(T2);

    // REVIEW-GATED (services/review-gate.ts): email possibles are NOT promoted at
    // ingestion — they wait for the owner. Rows stay 'pending' (or 'duplicate' when live
    // embeddings collapse two near-identical titles) and NO task exists yet.
    const rows = sqlite
      .prepare(`SELECT status, promoted_task_id FROM possible_tasks`)
      .all() as { status: string; promoted_task_id: string | null }[];
    expect(rows.length).toBe(2);
    expect(rows.every((x) => x.status === 'pending' || x.status === 'duplicate')).toBe(true);
    expect(rows.every((x) => x.promoted_task_id === null)).toBe(true);
    expect(r.promoted).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(0);
  });

  it('reads the persisted watermark and only processes newer messages on the next cycle', async () => {
    // Seed a watermark so m-1 is already past.
    sqlite
      .prepare(
        `INSERT INTO sync_state (id, owner_id, provider, account, resource, cursor)
         VALUES ('seed-since', ?, 'google', ?, 'gmail_since', ?)`,
      )
      .run(SYSTEM_OWNER, ACCOUNT, T1);

    const client = fakeClient([
      { id: 'm-1', from: 'a@x.io', subject: 'Old', body: 'old', receivedAt: T1 },
      { id: 'm-2', from: 'b@x.io', subject: 'New', body: 'new', receivedAt: T3 },
    ]);

    const r = await run(() => ingestEmails(client));

    // Only the newer message was seen (since-filter applied). The watermark is newer
    // than the lookback floor, so the floor does not interfere.
    expect(r.itemsProcessed).toBe(1);
    expect(r.possiblesCreated).toBe(1);
    expect(readCursor('gmail_since')?.cursor).toBe(T3);
  });

  it('dead-letters a poison message (queryable), continues, and still advances the watermark', async () => {
    const client = fakeClient([
      { id: 'm-1', from: 'a@x.io', subject: 'Good A', body: 'ok', receivedAt: T1 },
      { id: POISON_ID, from: 'b@x.io', subject: 'Bad', body: 'explodes', receivedAt: T2 },
      { id: 'm-3', from: 'c@x.io', subject: 'Good C', body: 'ok', receivedAt: T3 },
    ]);

    const r = await run(() => ingestEmails(client));

    // The two healthy messages still produced possibles — the poison didn't wedge the batch.
    expect(r.possiblesCreated).toBe(2);
    // Review-gated: they are NOT promoted, so they remain awaiting the owner. (Under
    // live embeddings a near-duplicate pair can collapse, so assert "no task created"
    // rather than an exact pending count.)
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(0);

    // The poison id is recorded in the dead-letter list (queryable JSON array).
    const dl = readCursor('gmail_deadletter');
    expect(dl?.cursor).toBeTruthy();
    expect(JSON.parse(dl!.cursor!)).toContain(POISON_ID);

    // The watermark advanced PAST the poison message (not wedged, not lost forever).
    expect(readCursor('gmail_since')?.cursor).toBe(T3);
  });
});
