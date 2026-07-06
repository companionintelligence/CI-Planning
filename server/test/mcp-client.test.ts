import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  McpGoogleSession,
  McpUnavailable,
  REQUIRED_TOOLS,
  MCP_TOKEN_ENV,
  type McpClientLike,
  type McpConnection,
  type McpConnectionFactory,
  type McpConnectParams,
} from '../src/mcp/client.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { logger } from '../src/lib/logger.js';
import { GoogleCalendarConnector } from '../src/connectors/google.js';
import { config } from '../src/lib/config.js';
import { resetDb } from './helpers.js';

const KEY = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;

const ALL_TOOLS = [
  ...Object.values(REQUIRED_TOOLS.calendar),
  ...Object.values(REQUIRED_TOOLS.gmail),
];

/** A no-op transport — the fake client never reads it, but the type demands one. */
const fakeTransport = {
  async start() {},
  async send() {},
  async close() {},
} as unknown as Transport;

interface FakeClientOpts {
  tools?: string[];
  /** Per-call behavior: return a value or throw. Receives the AbortSignal + call index. */
  onCall: (
    name: string,
    args: Record<string, unknown>,
    ctx: { callIndex: number; signal?: AbortSignal },
  ) => Promise<unknown>;
  listToolsThrows?: boolean;
  connectThrows?: boolean;
}

interface Recorded {
  connections: McpConnection[];
  spawnTokens: string[];
  callCount: number;
  closes: number;
}

/** Build a connection factory whose client is fully scripted. */
function makeFactory(opts: FakeClientOpts): { factory: McpConnectionFactory; rec: Recorded } {
  const rec: Recorded = { connections: [], spawnTokens: [], callCount: 0, closes: 0 };
  const tools = opts.tools ?? ALL_TOOLS;
  const factory: McpConnectionFactory = (params: McpConnectParams) => {
    rec.spawnTokens.push(params.accessToken);
    const env: Record<string, string> = { [MCP_TOKEN_ENV]: params.accessToken };
    if (process.env.PATH) env.PATH = process.env.PATH;
    const client: McpClientLike = {
      async connect() {
        if (opts.connectThrows) throw new Error('connect boom');
      },
      async listTools() {
        if (opts.listToolsThrows) throw new Error('listTools boom');
        return { tools: tools.map((name) => ({ name })) };
      },
      async callTool(p, _schema, options) {
        const idx = rec.callCount++;
        return opts.onCall(p.name, p.arguments ?? {}, { callIndex: idx, signal: options?.signal });
      },
      async close() {
        rec.closes++;
      },
    };
    const conn: McpConnection = { client, transport: fakeTransport, env, args: [] };
    rec.connections.push(conn);
    return conn;
  };
  return { factory, rec };
}

/** Seed a connection_tokens row. `expiresAt` controls whether getAccessToken refreshes. */
function seedToken(account: string, accessToken: string, expiresAt: string) {
  const sealed = seal(
    JSON.stringify({ accessToken, refreshToken: 'RT-1', expiresAt }),
    Buffer.from(KEY, 'base64'),
  );
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
       VALUES (?, ?, 'google', ?, ?, ?, ?, 1)`,
    )
    .run(newId(), SYSTEM_OWNER, account, sealed.iv, sealed.authTag, sealed.ciphertext);
}

const FAR_FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

/** Make an error that classifyStatus reads as the given HTTP status. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status} from provider`), { status });
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);
}

describe('McpGoogleSession', () => {
  beforeEach(() => {
    resetDb();
    process.env.CP_KEK_B64 = KEY;
    delete process.env.CP_MCP_BREAKER_THRESHOLD;
    delete process.env.CP_MCP_BREAKER_COOLDOWN_MS;
  });
  afterEach(() => {
    if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
    else process.env.CP_KEK_B64 = SAVED_KEK;
    vi.restoreAllMocks();
  });

  it('places the token in child env (not transport args) and never logs it (I6)', async () => {
    const secret = 'super-secret-access-token-xyz';
    seedToken('env@x.io', secret, FAR_FUTURE());
    const { factory, rec } = makeFactory({
      onCall: async () => ({ structuredContent: { messages: [] } }),
    });

    const logged: string[] = [];
    const spy = vi
      .spyOn(logger, 'info')
      .mockImplementation((msg, meta) => logged.push(msg + ' ' + JSON.stringify(meta ?? {})));
    vi.spyOn(logger, 'warn').mockImplementation((msg, meta) => logged.push(msg + ' ' + JSON.stringify(meta ?? {})));

    const session = new McpGoogleSession({ account: 'env@x.io', connectionFactory: factory });
    await run(() => session.listEmails());

    // token in env only
    expect(rec.connections[0].env[MCP_TOKEN_ENV]).toBe(secret);
    expect(rec.connections[0].args.join(' ')).not.toContain(secret);
    // never logged
    expect(logged.join('\n')).not.toContain(secret);
    spy.mockRestore();
  });

  it('throws McpUnavailable naming a missing tool (contract pin)', async () => {
    seedToken('miss@x.io', 'tok', FAR_FUTURE());
    const savedGmail = config.google.enableGmail;
    config.google.enableGmail = true; // the Gmail contract is only pinned when Gmail is enabled
    try {
      const { factory } = makeFactory({
        tools: ALL_TOOLS.filter((t) => t !== REQUIRED_TOOLS.gmail.modifyLabels),
        onCall: async () => ({}),
      });
      const session = new McpGoogleSession({ account: 'miss@x.io', connectionFactory: factory });
      await expect(run(() => session.listEmails())).rejects.toMatchObject({
        name: 'McpUnavailable',
      });
      await expect(run(() => session.listEmails())).rejects.toThrow(REQUIRED_TOOLS.gmail.modifyLabels);
    } finally {
      config.google.enableGmail = savedGmail;
    }
  });

  it('spawns calendar-only (no Gmail tools) when enableGmail is false', async () => {
    seedToken('cal-only@x.io', 'tok', FAR_FUTURE());
    const savedGmail = config.google.enableGmail;
    config.google.enableGmail = false; // calendar-only deployment — the recommended first live rung
    try {
      // The MCP server exposes ONLY the 4 calendar tools (Gmail not approved / CASA pending).
      const { factory } = makeFactory({
        tools: Object.values(REQUIRED_TOOLS.calendar),
        onCall: async () => ({ structuredContent: { events: [] } }),
      });
      const session = new McpGoogleSession({ account: 'cal-only@x.io', connectionFactory: factory });
      // Must NOT throw "Required MCP tool missing: gmail_*" — calendar sync works without Gmail.
      const page = await run(() => session.listEvents());
      expect(page.events).toEqual([]);
    } finally {
      config.google.enableGmail = savedGmail;
    }
  });

  it('aborts a slow call via the per-call timeout → McpUnavailable', async () => {
    seedToken('slow@x.io', 'tok', FAR_FUTURE());
    // A genuinely slow tool that honors the AbortSignal the session passes in. The
    // session's 30ms timer aborts it; the tool rejects with an AbortError, which the
    // session maps to McpUnavailable("timed out").
    const { factory } = makeFactory({
      onCall: (_n, _a, { signal }) =>
        new Promise((_resolve, reject) => {
          const t = setTimeout(() => _resolve({ structuredContent: { messages: [] } }), 5000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    });
    const session = new McpGoogleSession({
      account: 'slow@x.io',
      connectionFactory: factory,
      timeoutMs: 30,
    });
    await expect(run(() => session.listEmails())).rejects.toMatchObject({ name: 'McpUnavailable' });
    await expect(run(() => session.listEmails())).rejects.toThrow(/timed out/);
  });

  it('retries 503 twice then succeeds; does NOT retry 400', async () => {
    seedToken('retry@x.io', 'tok', FAR_FUTURE());
    let calls = 0;
    const { factory } = makeFactory({
      onCall: async () => {
        calls++;
        if (calls <= 2) throw httpError(503);
        return { structuredContent: { messages: [{ id: 'm1', from: 'a', subject: 's', body: 'b', receivedAt: 'r' }] } };
      },
    });
    const session = new McpGoogleSession({ account: 'retry@x.io', connectionFactory: factory });
    const out = await run(() => session.listEmails());
    expect(out).toHaveLength(1);
    expect(calls).toBe(3);

    // 400 is not retried.
    let calls400 = 0;
    const { factory: f400 } = makeFactory({
      onCall: async () => {
        calls400++;
        throw httpError(400);
      },
    });
    seedToken('retry400@x.io', 'tok', FAR_FUTURE());
    const s400 = new McpGoogleSession({ account: 'retry400@x.io', connectionFactory: f400 });
    await expect(run(() => s400.listEmails())).rejects.toMatchObject({ name: 'McpUnavailable' });
    expect(calls400).toBe(1);
  });

  it('401 once → forced refresh + respawn + retry succeeds (exactly one refresh)', async () => {
    // Stored token is EXPIRED so the first spawn refreshes (refresh #1), and the 401
    // forces a second refresh (refresh #2). We assert exactly one *forced* refresh by
    // counting spawns + checking the recover path runs once.
    seedToken('auth@x.io', 'tok', FAR_FUTURE()); // valid → first spawn does NOT refresh
    let calls = 0;
    const { factory, rec } = makeFactory({
      onCall: async () => {
        calls++;
        if (calls === 1) throw httpError(401);
        return { structuredContent: { messages: [{ id: 'm1', from: 'a', subject: 's', body: 'b', receivedAt: 'r' }] } };
      },
    });
    // Stub the provider refresh so forceRefresh resolves.
    const refreshSpy = stubProviderRefresh();
    const session = new McpGoogleSession({ account: 'auth@x.io', connectionFactory: factory });
    const out = await run(() => session.listEmails());
    expect(out).toHaveLength(1);
    // Two spawns: initial + respawn after forced refresh.
    expect(rec.connections.length).toBe(2);
    // Old connection was closed during recovery.
    expect(rec.closes).toBeGreaterThanOrEqual(1);
    // Exactly ONE forced provider refresh (the 401 recovery).
    expect(refreshSpy.calls).toBe(1);
  });

  it('401 twice → McpUnavailable', async () => {
    seedToken('auth2@x.io', 'tok', FAR_FUTURE());
    const { factory } = makeFactory({
      onCall: async () => {
        throw httpError(401);
      },
    });
    stubProviderRefresh();
    const session = new McpGoogleSession({ account: 'auth2@x.io', connectionFactory: factory });
    await expect(run(() => session.listEmails())).rejects.toMatchObject({ name: 'McpUnavailable' });
  });

  it('R2: concurrent 401-driven respawns share ONE forced refresh', async () => {
    seedToken('r2@x.io', 'tok', FAR_FUTURE());
    let firstWave = true;
    const { factory } = makeFactory({
      onCall: async () => {
        // Every call in the first wave 401s; after recovery, calls succeed.
        if (firstWave) throw httpError(401);
        return { structuredContent: { events: [] } };
      },
    });
    const refreshSpy = stubProviderRefresh(() => {
      firstWave = false;
    });
    const session = new McpGoogleSession({ account: 'r2@x.io', connectionFactory: factory });
    // Fire several listEvents concurrently; all hit 401 and trigger recovery together.
    await run(() => Promise.all([session.listEvents(), session.listEvents(), session.listEvents(), session.listEvents()]));
    // Exactly ONE provider refresh despite N concurrent 401 respawns.
    expect(refreshSpy.calls).toBe(1);
  });

  it('opens the circuit breaker after the threshold and fails fast', async () => {
    seedToken('cb@x.io', 'tok', FAR_FUTURE());
    process.env.CP_MCP_BREAKER_THRESHOLD = '3';
    process.env.CP_MCP_BREAKER_COOLDOWN_MS = '60000';
    let calls = 0;
    const { factory } = makeFactory({
      onCall: async () => {
        calls++;
        throw httpError(400); // non-retryable → each call is one failure
      },
    });
    const session = new McpGoogleSession({ account: 'cb@x.io', connectionFactory: factory });
    // Three failures → breaker opens.
    for (let i = 0; i < 3; i++) {
      await expect(run(() => session.listEvents())).rejects.toMatchObject({ name: 'McpUnavailable' });
    }
    const callsBefore = calls;
    // Next call must fail fast WITHOUT invoking the tool.
    await expect(run(() => session.listEvents())).rejects.toThrow(/circuit breaker is open/);
    expect(calls).toBe(callsBefore);
  });

  it('calendar listEvents maps RemoteEvent shape incl. etag passthrough', async () => {
    seedToken('cal@x.io', 'tok', FAR_FUTURE());
    const { factory } = makeFactory({
      onCall: async () => ({
        structuredContent: {
          events: [
            { id: 'e1', title: 'Sync', start: '2026-06-24T10:00:00Z', end: '2026-06-24T11:00:00Z', etag: 'W/"abc"' },
          ],
          nextSyncToken: 'tok-123',
        },
      }),
    });
    const session = new McpGoogleSession({ account: 'cal@x.io', connectionFactory: factory });
    const { events, nextSyncToken } = await run(() => session.listEvents());
    expect(nextSyncToken).toBe('tok-123');
    expect(events[0]).toMatchObject({ id: 'e1', title: 'Sync', etag: 'W/"abc"' });
  });
});

/**
 * Stub GoogleCalendarConnector.refreshToken (the provider refresh the TokenBearer
 * delegates to) so forceRefresh resolves without a network call. The TokenBearer
 * delegates to GoogleCalendarConnector#refreshToken (protected) — patch the prototype
 * so every instance shares this stub. Returns a live call counter.
 */
function stubProviderRefresh(onRefresh?: () => void): { calls: number } {
  const counter = { calls: 0 };
  const proto = GoogleCalendarConnector.prototype as unknown as {
    refreshToken: (rt: string) => Promise<{ accessToken: string; expiresAt: string }>;
  };
  vi.spyOn(proto, 'refreshToken').mockImplementation(async () => {
    counter.calls++;
    onRefresh?.();
    // Yield so concurrent forced refreshes all reach the single-flight gate first.
    await new Promise((r) => setTimeout(r, 5));
    return {
      accessToken: `refreshed-${counter.calls}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  });
  return counter;
}
