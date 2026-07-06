import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createFixtureGoogleClient, createGoogleClient, createLiveGoogleClient } from '../src/mcp/google.js';
import type { McpConnectionFactory } from '../src/mcp/client.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';

describe('Google MCP client (fixture-backed)', () => {
  const client = createFixtureGoogleClient();

  it('lists email fixtures', async () => {
    const emails = await client.listEmails();
    expect(emails.length).toBeGreaterThanOrEqual(20);
    for (const e of emails) {
      expect(e.id).toBeTruthy();
      expect(e.subject).toBeTruthy();
      expect(e.body).toBeTruthy();
      expect(Number.isNaN(new Date(e.receivedAt).getTime())).toBe(false);
    }
  });

  it('lists calendar fixtures with valid time ranges', async () => {
    const events = await client.listEvents();
    expect(events.length).toBeGreaterThanOrEqual(16);
    for (const ev of events) {
      expect(new Date(ev.end).getTime()).toBeGreaterThanOrEqual(new Date(ev.start).getTime());
    }
  });

  it('filters emails by since', async () => {
    const all = await client.listEmails();
    const cutoff = '2026-05-28T00:00:00.000Z';
    const recent = await client.listEmails({ since: cutoff });
    expect(recent.length).toBeLessThan(all.length);
    expect(recent.every((e) => e.receivedAt >= cutoff)).toBe(true);
  });

  it('filters events by from/to window', async () => {
    const windowed = await client.listEvents({ from: '2026-06-02T00:00:00.000Z', to: '2026-06-03T23:59:59.000Z' });
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.every((e) => e.start >= '2026-06-02T00:00:00.000Z' && e.start <= '2026-06-03T23:59:59.000Z')).toBe(true);
  });

  it('respects a limit', async () => {
    const five = await client.listEmails({ limit: 5 });
    expect(five.length).toBe(5);
  });

  it('createGoogleClient() defaults to fixture mode under GOOGLE_MODE=fixture', () => {
    expect(createGoogleClient().mode).toBe('fixture');
  });
});

describe('Google MCP client (live mode, fail-closed)', () => {
  const KEY = randomBytes(32).toString('base64');
  const SAVED_KEK = process.env.CP_KEK_B64;

  beforeEach(() => {
    resetDb();
    process.env.CP_KEK_B64 = KEY;
    const sealed = seal(
      JSON.stringify({ accessToken: 'tok', refreshToken: 'RT-1', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
      Buffer.from(KEY, 'base64'),
    );
    sqlite
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
         VALUES (?, ?, 'google', 'primary', ?, ?, ?, 1)`,
      )
      .run(newId(), SYSTEM_OWNER, sealed.iv, sealed.authTag, sealed.ciphertext);
  });
  afterEach(() => {
    if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
    else process.env.CP_KEK_B64 = SAVED_KEK;
  });

  it('reports mode "live"', () => {
    expect(createLiveGoogleClient({ command: 'noop' }).mode).toBe('live');
  });

  it('throws McpUnavailable on transport failure — NO fixture fallback', async () => {
    // A connection factory whose connect() fails: the live client must surface this as
    // McpUnavailable and return ZERO rows (never silently fall back to fixtures).
    const failingFactory: McpConnectionFactory = ({ accessToken }) => ({
      env: { GOOGLE_ACCESS_TOKEN: accessToken },
      args: [],
      transport: { async start() {}, async send() {}, async close() {} } as never,
      client: {
        async connect() {
          throw new Error('spawn ENOENT: no MCP server');
        },
        async listTools() {
          return { tools: [] };
        },
        async callTool() {
          return {};
        },
        async close() {},
      },
    });
    const client = createLiveGoogleClient({ command: 'noop', connectionFactory: failingFactory });

    let threw: Error | null = null;
    let rows: unknown[] | null = null;
    try {
      rows = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => client.listEmails());
    } catch (err) {
      threw = err as Error;
    }
    expect(threw?.name).toBe('McpUnavailable');
    expect(rows).toBeNull(); // proves no fixture rows were returned
  });

  it('maps MCP results into EmailMessage / CalendarEvent over a fake transport', async () => {
    const okFactory: McpConnectionFactory = ({ accessToken }) => ({
      env: { GOOGLE_ACCESS_TOKEN: accessToken },
      args: [],
      transport: { async start() {}, async send() {}, async close() {} } as never,
      client: {
        async connect() {},
        async listTools() {
          return {
            tools: [
              'calendar_list_events',
              'calendar_create_event',
              'calendar_update_event',
              'calendar_delete_event',
              'gmail_list_messages',
              'gmail_get_message',
              'gmail_modify_labels',
            ].map((name) => ({ name })),
          };
        },
        async callTool(p) {
          if (p.name === 'gmail_list_messages') {
            return {
              structuredContent: {
                messages: [{ id: 'm1', from: 'a@x.io', subject: 'Hi', body: 'Body', receivedAt: '2026-06-24T00:00:00Z' }],
              },
            };
          }
          return {
            structuredContent: {
              events: [{ id: 'e1', title: 'Standup', start: '2026-06-24T09:00:00Z', end: '2026-06-24T09:15:00Z', etag: 'W/"1"' }],
            },
          };
        },
        async close() {},
      },
    });
    const client = createLiveGoogleClient({ command: 'noop', connectionFactory: okFactory });
    const emails = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => client.listEmails());
    expect(emails[0]).toMatchObject({ id: 'm1', subject: 'Hi' });
    const events = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => client.listEvents());
    expect(events[0]).toMatchObject({ id: 'e1', title: 'Standup', description: '' });
  });
});
