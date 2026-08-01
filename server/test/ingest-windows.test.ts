import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import type { GoogleClient, EmailMessage } from '../src/mcp/google.js';

/**
 * Ingestion windows (0147) — `memory_window_days` and `email_lookback_days`.
 *
 * The two point in OPPOSITE directions and that asymmetry is the point: the memory pull
 * mirrors UPCOMING events into tasks, so widening it must reach FURTHER AHEAD, while an
 * inbox is only ever read backwards.
 *
 * Extraction is stubbed (one task per message) so the email half runs without Ollama —
 * same idiom as gmail-cursor.test.ts, and it must be hoisted above the ingest import.
 */
vi.mock('../src/agents/extract.js', () => ({
  extractTasks: vi.fn(async (source: { subject?: string; text: string }) => [
    {
      title: (source.subject ?? source.text).slice(0, 200) || 'Todo',
      summary: undefined,
      priority: 3,
      dueAt: null,
      estimatedMinutes: null,
      tags: [],
      confidence: 0.9,
    },
  ]),
}));

import { ingestEmails } from '../src/agents/ingest.js';
import { suggestFromMemory } from '../src/agents/memory-suggest.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;
const ACCOUNT = 'primary';
const run = <T,>(fn: () => T | Promise<T>) => runWithOwner(OWNER, ALL_SCOPES, fn);

const SAVED = { url: process.env.CI_SERVER_URL, apiKey: process.env.CI_SERVER_API_KEY, mode: process.env.MEMORY_MODE };

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => {
  await srv.close();
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore('CI_SERVER_URL', SAVED.url);
  restore('CI_SERVER_API_KEY', SAVED.apiKey);
  restore('MEMORY_MODE', SAVED.mode);
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function fakeClient(emails: EmailMessage[]): GoogleClient {
  return {
    mode: 'fixture',
    // Honor `since` exactly as the real Gmail tool does, so the floor is observable.
    async listEmails(opts = {}) {
      return opts.since ? emails.filter((e) => e.receivedAt > opts.since!) : emails;
    },
    async listEvents() { return []; },
  };
}

const readCursor = () =>
  (sqlite
    .prepare(
      `SELECT cursor FROM sync_state
        WHERE owner_id = ? AND provider = 'google' AND account = ? AND resource = 'gmail_since'`,
    )
    .get(OWNER, ACCOUNT) as { cursor: string | null } | undefined)?.cursor ?? null;

// ── the setting itself ──────────────────────────────────────────────────────────

describe('ingestion window prefs (0147)', () => {
  beforeEach(() => { resetDb(); });

  it('defaults to the pre-0147 behavior: 2-day memory window, 7-day email lookback', async () => {
    const { prefs } = (await api(srv.url, '/api/prefs')).body;
    expect(prefs.memory_window_days).toBe(2);   // = the 48h the agents used to hardcode
    expect(prefs.email_lookback_days).toBe(7);
  });

  it('round-trips both settings through PATCH', async () => {
    const r = await api(srv.url, '/api/prefs', {
      method: 'PATCH',
      json: { memory_window_days: 5, email_lookback_days: 30 },
    });
    expect(r.status).toBe(200);
    const { prefs } = (await api(srv.url, '/api/prefs')).body;
    expect(prefs.memory_window_days).toBe(5);
    expect(prefs.email_lookback_days).toBe(30);
  });

  // Rejecting rather than clamping matters: a clamped value leaves the Settings input
  // showing a number the server never stored.
  it.each([
    ['memory_window_days', 0],
    ['memory_window_days', 31],
    ['memory_window_days', 2.5],
    ['memory_window_days', 'lots'],
    ['email_lookback_days', 0],
    ['email_lookback_days', 91],
    ['email_lookback_days', null],
  ])('rejects %s = %o with 422 and persists nothing', async (field, value) => {
    const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { [field]: value } });
    expect(r.status).toBe(422);
    const { prefs } = (await api(srv.url, '/api/prefs')).body;
    expect(prefs.memory_window_days).toBe(2);
    expect(prefs.email_lookback_days).toBe(7);
  });

  it('accepts each range boundary', async () => {
    for (const [field, value] of [
      ['memory_window_days', 1], ['memory_window_days', 30],
      ['email_lookback_days', 1], ['email_lookback_days', 90],
    ] as const) {
      const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { [field]: value } });
      expect(r.status).toBe(200);
      expect(r.body.prefs[field]).toBe(value);
    }
  });
});

// ── email: the lookback floor ───────────────────────────────────────────────────

describe('email_lookback_days floors the Gmail ingest window', () => {
  beforeEach(() => {
    resetDb();
    sqlite.exec(
      'DELETE FROM possible_task_tags; DELETE FROM possible_tasks; DELETE FROM tags; DELETE FROM sync_state;'
      + 'DELETE FROM time_blocks; DELETE FROM flight_plan; DELETE FROM entity_tags; DELETE FROM tasks;',
    );
  });

  it('bounds a FIRST ingest (no watermark) to the configured window', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { email_lookback_days: 7 } });
    const client = fakeClient([
      { id: 'old', from: 'a@x.io', subject: 'Ancient', body: 'x', receivedAt: daysAgo(60) },
      { id: 'new', from: 'b@x.io', subject: 'Recent', body: 'y', receivedAt: daysAgo(2) },
    ]);

    const r = await run(() => ingestEmails(client));

    // Only the in-window message was read. Before 0147 an empty watermark meant NO
    // `since` at all, so both would have been pulled through extraction.
    expect(r.itemsProcessed).toBe(1);
    const titles = sqlite.prepare(`SELECT raw_title FROM possible_tasks`).all() as { raw_title: string }[];
    expect(titles.map((t) => t.raw_title)).toEqual(['Recent']);
  });

  it('widening the setting reaches further back on a first ingest', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { email_lookback_days: 90 } });
    const client = fakeClient([
      { id: 'old', from: 'a@x.io', subject: 'Ancient', body: 'x', receivedAt: daysAgo(60) },
      { id: 'new', from: 'b@x.io', subject: 'Recent', body: 'y', receivedAt: daysAgo(2) },
    ]);

    const r = await run(() => ingestEmails(client));
    expect(r.itemsProcessed).toBe(2);
  });

  it('takes the LATER of watermark and floor — a fresh watermark wins', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { email_lookback_days: 30 } });
    sqlite
      .prepare(
        `INSERT INTO sync_state (id, owner_id, provider, account, resource, cursor)
         VALUES ('seed', ?, 'google', ?, 'gmail_since', ?)`,
      )
      .run(OWNER, ACCOUNT, daysAgo(1));

    const client = fakeClient([
      { id: 'mid', from: 'a@x.io', subject: 'Ten days old', body: 'x', receivedAt: daysAgo(10) },
      { id: 'new', from: 'b@x.io', subject: 'Fresh', body: 'y', receivedAt: daysAgo(0.5) },
    ]);

    const r = await run(() => ingestEmails(client));

    // The watermark (1d) is newer than the floor (30d) — the floor must not drag the
    // window BACKWARDS and re-ingest what was already processed.
    expect(r.itemsProcessed).toBe(1);
  });

  it('takes the LATER of watermark and floor — a stale watermark loses to the floor', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { email_lookback_days: 7 } });
    sqlite
      .prepare(
        `INSERT INTO sync_state (id, owner_id, provider, account, resource, cursor)
         VALUES ('seed', ?, 'google', ?, 'gmail_since', ?)`,
      )
      .run(OWNER, ACCOUNT, daysAgo(120)); // reconnected after a long outage

    const client = fakeClient([
      { id: 'old', from: 'a@x.io', subject: 'Backlog', body: 'x', receivedAt: daysAgo(60) },
      { id: 'new', from: 'b@x.io', subject: 'Recent', body: 'y', receivedAt: daysAgo(1) },
    ]);

    const r = await run(() => ingestEmails(client));

    // The 60-day-old backlog is deliberately skipped (and the watermark jumps past it):
    // "look back 7 days" is an instruction to cap the queue, not merely to seed it.
    expect(r.itemsProcessed).toBe(1);
    // …and the watermark jumps past the skipped backlog rather than staying stuck at
    // 120 days and re-offering it on every subsequent run.
    expect(readCursor()! > daysAgo(2)).toBe(true);
  });

  it('an explicit opts.since bypasses the floor (manual replay)', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { email_lookback_days: 1 } });
    const client = fakeClient([
      { id: 'old', from: 'a@x.io', subject: 'Ancient', body: 'x', receivedAt: daysAgo(60) },
    ]);

    const r = await run(() => ingestEmails(client, { since: daysAgo(365) }));
    expect(r.itemsProcessed).toBe(1); // the caller named the window; the floor stands aside
  });
});

// ── memory: the forward window ──────────────────────────────────────────────────

describe('memory_window_days sizes the memory pull', () => {
  // The committed fixture graph holds events at now+20h, now+30h and now+90h, so a
  // 2-day window sees two and a 4-day window sees all three.
  beforeEach(async () => {
    resetDb();
    process.env.MEMORY_MODE = 'fixture';
    process.env.CI_SERVER_URL = 'http://ci.local:3000';
    delete process.env.CI_SERVER_API_KEY;
    const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_pull_enabled: true } });
    expect(r.status).toBe(200);
  });

  it('defaults to 2 days — the pre-0147 48h behavior, unchanged', async () => {
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.status).toBe('ran');
    expect(r.pulled).toBe(2); // +20h and +30h; +90h is out of window
  });

  it('widening it reaches FORWARD to a further-out event', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_window_days: 4 } });
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.pulled).toBe(3); // +90h now falls inside
  });

  it('narrowing it to 1 day drops the events beyond 24h', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_window_days: 1 } });
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.pulled).toBe(1); // only +20h
  });
});
