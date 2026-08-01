import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  McpGoogleSession,
  McpUnavailable,
  REQUIRED_TOOLS,
  MCP_TOKEN_ENV,
  etagFromFailure,
  type McpClientLike,
  type McpConnection,
  type McpConnectionFactory,
  type McpConnectParams,
} from '../src/mcp/client.js';
import { buildGoogleScopes } from '../src/mcp/gmail-flag.js';
import { createLiveGoogleClient } from '../src/mcp/google.js';
import { GoogleCalendarConnector } from '../src/connectors/google.js';
import { EtagConflictError } from '../src/connectors/base.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { config } from '../src/lib/config.js';
import { resetDb } from './helpers.js';

/**
 * RC7 — the four defects that made the Google connector unusable. They are covered in
 * ONE file because they had to ship together: fixing the scope alone would have turned a
 * dead feature into a live one that leaks child processes, never resolves etag
 * conflicts, and reports success while wholly failing.
 */

const KEY = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;

const ALL_TOOLS = [...Object.values(REQUIRED_TOOLS.calendar), ...Object.values(REQUIRED_TOOLS.gmail)];

const fakeTransport = { async start() {}, async send() {}, async close() {} } as unknown as Transport;

interface Recorded {
  closes: number;
  spawns: number;
}

/** Connection factory whose client is scripted per call and counts closes. */
function makeFactory(onCall: (name: string) => Promise<unknown>): {
  factory: McpConnectionFactory;
  rec: Recorded;
} {
  const rec: Recorded = { closes: 0, spawns: 0 };
  const factory: McpConnectionFactory = (params: McpConnectParams) => {
    rec.spawns++;
    const env: Record<string, string> = { [MCP_TOKEN_ENV]: params.accessToken };
    const client: McpClientLike = {
      async connect() {},
      async listTools() {
        return { tools: ALL_TOOLS.map((name) => ({ name })) };
      },
      async callTool(p) {
        return onCall(p.name);
      },
      async close() {
        rec.closes++;
      },
    };
    const conn: McpConnection = { client, transport: fakeTransport, env, args: [] };
    return conn;
  };
  return { factory, rec };
}

function seedToken(account: string) {
  const sealed = seal(
    JSON.stringify({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
    Buffer.from(KEY, 'base64'),
  );
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
       VALUES (?, ?, 'google', ?, ?, ?, ?, 1)`,
    )
    .run(newId(), SYSTEM_OWNER, account, sealed.iv, sealed.authTag, sealed.ciphertext);
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);
}

beforeEach(() => {
  resetDb();
  process.env.CP_KEK_B64 = KEY;
});
afterEach(() => {
  if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED_KEK;
  vi.restoreAllMocks();
});

// ── Defect 1: no identity scopes ⇒ no id_token ⇒ connect can never complete ──────
describe('RC7-1 OAuth identity scopes', () => {
  it('requests openid + email so Google returns an id_token', () => {
    const scopes = buildGoogleScopes();
    // Without BOTH of these Google issues no id_token, resolveAccountEmail() returns
    // null, and the callback dies with could_not_verify_account_identity.
    expect(scopes).toContain('openid');
    expect(scopes).toContain('email');
  });

  it('still includes calendar, and gates gmail behind the CASA flag', () => {
    const saved = config.google.enableGmail;
    try {
      (config.google as { enableGmail: boolean }).enableGmail = false;
      const withoutGmail = buildGoogleScopes({ gmail: true });
      expect(withoutGmail).toContain('https://www.googleapis.com/auth/calendar.events');
      expect(withoutGmail).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
      // Identity is unconditional — it must not ride on the gmail flag.
      expect(withoutGmail).toContain('openid');

      (config.google as { enableGmail: boolean }).enableGmail = true;
      const withGmail = buildGoogleScopes({ gmail: true });
      expect(withGmail).toContain('https://www.googleapis.com/auth/gmail.readonly');
      expect(withGmail).toContain('openid');
    } finally {
      (config.google as { enableGmail: boolean }).enableGmail = saved;
    }
  });
});

// ── Defect 2: MCP children spawned every cycle and never reaped ──────────────────
describe('RC7-2 MCP child lifecycle', () => {
  it('live GoogleClient.close() tears down the spawned child', async () => {
    seedToken('leak@x.io');
    const { factory, rec } = makeFactory(async () => ({ structuredContent: { messages: [] } }));

    await run(async () => {
      const client = createLiveGoogleClient({ account: 'leak@x.io', connectionFactory: factory });
      await client.listEmails({});
      expect(rec.spawns).toBe(1);
      expect(rec.closes).toBe(0);
      await client.close();
    });

    expect(rec.closes).toBe(1);
  });

  it('closing without ever calling a tool is a safe no-op', async () => {
    seedToken('noop@x.io');
    const { factory, rec } = makeFactory(async () => ({}));
    await run(async () => {
      const client = createLiveGoogleClient({ account: 'noop@x.io', connectionFactory: factory });
      await client.close();
    });
    expect(rec.spawns).toBe(0);
    expect(rec.closes).toBe(0);
  });

  it('connector.close() reaps its session and is idempotent', async () => {
    seedToken('conn@x.io');
    const { factory, rec } = makeFactory(async () => ({
      structuredContent: { events: [], nextSyncToken: null },
    }));

    await run(async () => {
      const connector = new GoogleCalendarConnector('conn@x.io', {
        sessionFactory: () =>
          new McpGoogleSession({ account: 'conn@x.io', connectionFactory: factory }),
      });
      await connector.listEvents({});
      expect(rec.spawns).toBe(1);
      await connector.close();
      await connector.close(); // idempotent — must not throw or double-close
    });

    expect(rec.closes).toBe(1);
  });
});

// ── Defect 3: etag lost when errors were funnelled through McpUnavailable ────────
describe('RC7-3 etag propagation', () => {
  it('etagFromFailure reads a structured etag, then falls back to text', () => {
    expect(etagFromFailure({ freshEtag: 'W/"aaa"' })).toBe('W/"aaa"');
    expect(etagFromFailure({ etag: 'W/"bbb"' })).toBe('W/"bbb"');
    expect(etagFromFailure(new Error('412 precondition failed, etag: "W/xyz"'))).toBe('W/xyz');
    expect(etagFromFailure(new Error('500 boom'))).toBeNull();
  });

  it('a 412 carries the fresh etag through McpUnavailable to EtagConflictError', async () => {
    seedToken('etag@x.io');
    // The MCP server stringifies the upstream Google error — the shape the live path
    // actually produces, and the shape that previously lost the etag entirely.
    const { factory } = makeFactory(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'Google API error 412: etag: "W/fresh-123" mismatch' }],
    }));

    await run(async () => {
      const connector = new GoogleCalendarConnector('etag@x.io', {
        sessionFactory: () =>
          new McpGoogleSession({ account: 'etag@x.io', connectionFactory: factory, retries: 0 }),
      });

      const err = await connector
        .updateEvent('evt-1', { title: 't', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }, 'W/stale')
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(EtagConflictError);
      // The whole point: null here means the conflict can never converge, because
      // agents/sync.ts only refreshes the stored etag when freshEtag !== null.
      expect((err as EtagConflictError).freshEtag).toBe('W/fresh-123');
    });
  });

  it('McpUnavailable exposes the upstream status', async () => {
    seedToken('status@x.io');
    const { factory } = makeFactory(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'Google API error 403: forbidden' }],
    }));

    await run(async () => {
      const session = new McpGoogleSession({
        account: 'status@x.io',
        connectionFactory: factory,
        retries: 0,
      });
      const err = await session
        .listEvents({})
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpUnavailable);
      expect((err as McpUnavailable).status).toBe(403);
    });
  });
});
