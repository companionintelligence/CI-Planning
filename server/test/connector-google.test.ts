import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { GoogleCalendarConnector, providerEventId } from '../src/connectors/google.js';
import { EtagConflictError } from '../src/connectors/base.js';
import { McpGoogleSession, type McpConnectionFactory } from '../src/mcp/client.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';

const ACCOUNT = 'primary';
const ALL_TOOLS = [
  'calendar_list_events',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'gmail_list_messages',
  'gmail_get_message',
  'gmail_modify_labels',
].map((name) => ({ name }));

/** Records every callTool invocation so tests can assert what the connector sent. */
interface Recorder {
  calls: { name: string; args: Record<string, unknown> }[];
}

/**
 * Build a connectionFactory whose callTool is driven by `handler`. `rec` captures every
 * call. The transport is inert; no spawn / network.
 */
function makeFactory(
  rec: Recorder,
  handler: (name: string, args: Record<string, unknown>) => unknown,
): McpConnectionFactory {
  return ({ accessToken }) => ({
    env: { GOOGLE_ACCESS_TOKEN: accessToken },
    args: [],
    transport: { async start() {}, async send() {}, async close() {} } as never,
    client: {
      async connect() {},
      async listTools() {
        return { tools: ALL_TOOLS };
      },
      async callTool(p: { name: string; arguments?: Record<string, unknown> }) {
        const args = p.arguments ?? {};
        rec.calls.push({ name: p.name, args });
        return handler(p.name, args);
      },
      async close() {},
    },
  });
}

/** A connector whose MCP session uses the injected factory (no real spawn). */
function connectorWith(factory: McpConnectionFactory): GoogleCalendarConnector {
  return new GoogleCalendarConnector(ACCOUNT, {
    sessionFactory: () =>
      new McpGoogleSession({ account: ACCOUNT, command: 'noop', connectionFactory: factory, retries: 0 }),
  });
}

describe('GoogleCalendarConnector (MCP-backed)', () => {
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
         VALUES (?, ?, 'google', ?, ?, ?, ?, 1)`,
      )
      .run(newId(), SYSTEM_OWNER, ACCOUNT, sealed.iv, sealed.authTag, sealed.ciphertext);
  });
  afterEach(() => {
    if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
    else process.env.CP_KEK_B64 = SAVED_KEK;
  });

  // ── (a) listEvents mapping + opts passthrough ──────────────────────────────
  it('maps a sample payload into RemoteEvents (etag/allDay/deleted) and passes syncToken', async () => {
    const rec: Recorder = { calls: [] };
    const factory = makeFactory(rec, () => ({
      structuredContent: {
        events: [
          { id: 'e1', title: 'Standup', start: '2026-06-24T09:00:00Z', end: '2026-06-24T09:15:00Z', etag: 'W/"1"' },
          { id: 'e2', title: 'All Day', start: '2026-06-25', end: '2026-06-26', etag: 'W/"2"', allDay: true },
          { id: 'e3', title: '', start: '2026-06-20T00:00:00Z', end: '2026-06-20T00:00:00Z', etag: null, deleted: true },
        ],
        nextSyncToken: 'tok-next',
        expired: false,
      },
    }));
    const connector = connectorWith(factory);

    const res = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => connector.listEvents({ syncToken: 'tok-prev' }));

    expect(res.nextSyncToken).toBe('tok-next');
    expect(res.events).toHaveLength(3);
    // Normal event → ISO-UTC, etag passthrough, no allDay.
    expect(res.events[0]).toMatchObject({ id: 'e1', title: 'Standup', etag: 'W/"1"' });
    expect(res.events[0].allDay).toBeUndefined();
    expect(res.events[0].start).toBe('2026-06-24T09:00:00.000Z');
    // Date-only / allDay event widened to UTC midnight + allDay:true.
    expect(res.events[1]).toMatchObject({ id: 'e2', allDay: true });
    expect(res.events[1].start).toBe('2026-06-25T00:00:00.000Z');
    // Cancelled event → deleted:true tombstone (R3).
    expect(res.events[2]).toMatchObject({ id: 'e3', deleted: true });

    // syncToken forwarded to the MCP tool (not from/to).
    expect(rec.calls[0].name).toBe('calendar_list_events');
    expect(rec.calls[0].args).toMatchObject({ syncToken: 'tok-prev' });
    expect(rec.calls[0].args.timeMin).toBeUndefined();
  });

  it('forwards from/to as timeMin/timeMax for a full window', async () => {
    const rec: Recorder = { calls: [] };
    const factory = makeFactory(rec, () => ({ structuredContent: { events: [], nextSyncToken: 't' } }));
    const connector = connectorWith(factory);

    await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () =>
      connector.listEvents({ from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' }),
    );
    expect(rec.calls[0].args).toMatchObject({
      timeMin: '2026-06-01T00:00:00Z',
      timeMax: '2026-06-30T00:00:00Z',
    });
    expect(rec.calls[0].args.syncToken).toBeUndefined();
  });

  // ── (b) createEvent idempotency-key + 409 read-back (I7) ───────────────────
  it('sends a deterministic id from idempotencyKey and reads back on a 409 (I7)', async () => {
    const key = '01890000-0000-7000-8000-000000000abc';
    const expectedId = providerEventId(key);
    const rec: Recorder = { calls: [] };

    // First create → simulate a 409 duplicate-id failure. The read-back list returns the
    // pre-existing event under the deterministic id.
    const factory = makeFactory(rec, (name) => {
      if (name === 'calendar_create_event') {
        throw Object.assign(new Error('duplicate id'), { status: 409 });
      }
      if (name === 'calendar_list_events') {
        return {
          structuredContent: {
            events: [{ id: expectedId, title: 'Existing', start: '2026-06-24T09:00:00Z', end: '2026-06-24T10:00:00Z', etag: 'W/"9"' }],
          },
        };
      }
      return {};
    });
    const connector = connectorWith(factory);

    const out = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () =>
      connector.createEvent({
        title: 'Block',
        start: '2026-06-24T09:00:00Z',
        end: '2026-06-24T10:00:00Z',
        idempotencyKey: key,
      }),
    );

    // Did NOT throw — returned the existing event.
    expect(out).toMatchObject({ id: expectedId, title: 'Existing', etag: 'W/"9"' });

    // The create call carried the deterministic id and matches Google's id rule.
    const createCall = rec.calls.find((c) => c.name === 'calendar_create_event')!;
    expect(createCall.args.idempotencyKey).toBe(expectedId);
    expect(expectedId).toMatch(/^[a-v0-9]{5,1024}$/);
  });

  it('returns the freshly created event on the happy path (no read-back)', async () => {
    const rec: Recorder = { calls: [] };
    const factory = makeFactory(rec, (name, args) => {
      if (name === 'calendar_create_event') {
        return {
          structuredContent: { id: String(args.idempotencyKey ?? 'minted'), title: String(args.title), start: args.start, end: args.end, etag: 'W/"new"' },
        };
      }
      return {};
    });
    const connector = connectorWith(factory);

    const out = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () =>
      connector.createEvent({ title: 'Fresh', start: '2026-06-24T09:00:00Z', end: '2026-06-24T10:00:00Z' }),
    );
    expect(out).toMatchObject({ id: 'minted', title: 'Fresh', etag: 'W/"new"' });
    expect(rec.calls.filter((c) => c.name === 'calendar_list_events')).toHaveLength(0);
  });

  // ── (c) update/delete If-Match + 412 → EtagConflictError ───────────────────
  it('sends ifMatch on update and translates a 412 into EtagConflictError', async () => {
    const rec: Recorder = { calls: [] };
    const factory = makeFactory(rec, (name) => {
      if (name === 'calendar_update_event') throw Object.assign(new Error('precondition failed'), { status: 412 });
      return {};
    });
    const connector = connectorWith(factory);

    const p = runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () =>
      connector.updateEvent('e1', { title: 'X', start: '2026-06-24T09:00:00Z', end: '2026-06-24T10:00:00Z' }, 'W/"old"'),
    );
    await expect(p).rejects.toBeInstanceOf(EtagConflictError);
    await expect(p).rejects.toMatchObject({ externalId: 'e1' });

    const call = rec.calls.find((c) => c.name === 'calendar_update_event')!;
    expect(call.args).toMatchObject({ id: 'e1', ifMatch: 'W/"old"' });
  });

  it('sends ifMatch on delete and translates a 412 into EtagConflictError', async () => {
    const rec: Recorder = { calls: [] };
    const factory = makeFactory(rec, (name) => {
      if (name === 'calendar_delete_event') throw Object.assign(new Error('precondition failed'), { status: 412 });
      return {};
    });
    const connector = connectorWith(factory);

    await expect(
      runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => connector.deleteEvent('e9', 'W/"old"')),
    ).rejects.toBeInstanceOf(EtagConflictError);

    const call = rec.calls.find((c) => c.name === 'calendar_delete_event')!;
    expect(call.args).toMatchObject({ id: 'e9', ifMatch: 'W/"old"' });
  });

  // ── (d) deleteEvent swallows 404/410 (idempotent) ──────────────────────────
  it('resolves deleteEvent successfully on a 404 (already gone)', async () => {
    const factory = makeFactory({ calls: [] }, (name) => {
      if (name === 'calendar_delete_event') throw Object.assign(new Error('not found'), { status: 404 });
      return {};
    });
    const connector = connectorWith(factory);
    await expect(runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => connector.deleteEvent('gone', null))).resolves.toBeUndefined();
  });

  it('resolves deleteEvent successfully on a 410 (already gone)', async () => {
    const factory = makeFactory({ calls: [] }, (name) => {
      if (name === 'calendar_delete_event') throw Object.assign(new Error('gone'), { status: 410 });
      return {};
    });
    const connector = connectorWith(factory);
    await expect(runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => connector.deleteEvent('gone', null))).resolves.toBeUndefined();
  });

  // ── providerEventId determinism ────────────────────────────────────────────
  it('providerEventId is deterministic and Google-id valid', () => {
    const key = '01890000-0000-7000-8000-000000000abc';
    expect(providerEventId(key)).toBe(providerEventId(key));
    expect(providerEventId(key)).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(providerEventId(key)).not.toBe(providerEventId('01890000-0000-7000-8000-000000000abd'));
  });
});
