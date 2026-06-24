import type { RemoteEvent, RemoteEventInput, ListEventsResult, ListEventsOpts } from './base.js';
import { BaseOAuth2Client, EtagConflictError } from './base.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { McpGoogleSession, McpUnavailable } from '../mcp/client.js';

/**
 * RFC 4648 base32hex alphabet (`0-9a-v`). Google Calendar event ids must match
 * `[a-v0-9]{5,1024}` (base32hex, lowercase) — so encoding the idempotency key's raw
 * bytes with this alphabet, lowercased and prefixed with a letter, yields a
 * deterministic, valid provider id. We omit padding (Google ids carry no '=').
 */
const BASE32HEX_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

/**
 * Encode raw bytes to (lowercase, unpadded) base32hex. Pure + dependency-free; no such
 * helper exists in lib/ids.ts (hex only), so this lives privately here.
 */
function base32hexEncode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32HEX_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Derive the deterministic provider event id from a caller idempotency key (typically a
 * dashed UUIDv7 block id). Strip the dashes, take the raw bytes, base32hex-encode, prefix
 * `'cp'` so the id always starts with a letter (Google's rule). The result is stable for a
 * given key, so a retried create lands on the SAME provider event (I7).
 */
export function providerEventId(idempotencyKey: string): string {
  const hex = idempotencyKey.replace(/-/g, '');
  // Interpret the key as hex bytes when it is clean hex (the UUID case); otherwise fall
  // back to its UTF-8 bytes so any caller-supplied string still yields a valid id.
  const isHex = hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex);
  const bytes = isHex
    ? Uint8Array.from(Buffer.from(hex, 'hex'))
    : Uint8Array.from(Buffer.from(idempotencyKey, 'utf8'));
  return ('cp' + base32hexEncode(bytes)).toLowerCase();
}

/**
 * Pull an HTTP-ish status out of an error surfaced by McpGoogleSession. The session wraps
 * provider failures in McpUnavailable with the upstream status embedded in the message
 * (`... (status 412): ...`); a raw thrown error may carry a numeric `status`. Returns 0
 * when nothing parseable is present.
 */
function statusOf(err: unknown): number {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.status === 'number') return o.status;
    const msg = typeof o.message === 'string' ? o.message : '';
    const m = msg.match(/\b(4\d\d|5\d\d)\b/);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Best-effort fresh etag from a conflict error or its embedded response, else null. */
function freshEtagOf(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.freshEtag === 'string') return o.freshEtag;
    if (typeof o.etag === 'string') return o.etag;
  }
  return null;
}

/** A date-only value (`YYYY-MM-DD`, no time component) signals a Google all-day event. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Final connector-level normalization over a session-mapped RemoteEvent:
 *  - start/end → ISO-UTC (a date-only `YYYY-MM-DD` is widened to UTC midnight),
 *  - allDay inferred from a date-only start when the session didn't already set it,
 *  - deleted preserved (R3): a cancelled/removed provider event arrives with
 *    `deleted: true` and is passed straight through as a tombstone signal for WP5.
 */
function normalizeRemoteEvent(e: RemoteEvent): RemoteEvent {
  const allDay = e.allDay ?? DATE_ONLY.test(e.start);
  return {
    id: e.id,
    title: e.title,
    start: toIsoUtc(e.start),
    end: toIsoUtc(e.end),
    etag: e.etag,
    ...(allDay ? { allDay: true } : {}),
    ...(e.deleted ? { deleted: true } : {}),
  };
}

/**
 * Coerce a provider timestamp to ISO-UTC. A date-only string becomes UTC midnight; any
 * other parseable value is normalized through Date; an unparseable/empty value is passed
 * through untouched (the session already stringified it).
 */
function toIsoUtc(v: string): string {
  if (!v) return v;
  if (DATE_ONLY.test(v)) return `${v}T00:00:00.000Z`;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? v : t.toISOString();
}

/**
 * Thrown when Google rejects a refresh with `invalid_grant` (HTTP 400) — the refresh
 * token has been revoked or expired. Callers (the sync agent, the disconnect route)
 * map this to a `status='error'`/re-auth path rather than a generic 500.
 */
export class RevokedTokenError extends Error {
  constructor(message = 'Google refresh token was revoked or expired (invalid_grant)') {
    super(message);
    this.name = 'RevokedTokenError';
  }
}

/**
 * POST the OAuth token endpoint with a urlencoded body. `client_secret` is only sent
 * when configured (installed-app clients may be public). Shared by refreshToken().
 */
async function postToken(params: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(params);
  return fetch(config.google.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

/**
 * Revoke a Google token (access OR refresh). RFC 7009 / Google's revoke endpoint:
 * the token MUST travel in the urlencoded BODY, never the URL query (I3) — a query
 * token leaks into access logs / browser history. Best-effort: a non-2xx (already
 * revoked, network blip) is logged and swallowed so disconnect always proceeds to the
 * local DELETE. Exported so the disconnect route can call it directly.
 */
export async function revoke(token: string): Promise<void> {
  if (!token) return;
  try {
    const res = await fetch(config.google.revokeUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!res.ok) {
      logger.warn('Google token revoke returned non-2xx', { status: res.status });
    }
  } catch (err) {
    logger.warn('Google token revoke failed (continuing with local disconnect)', {
      err: (err as Error).message,
    });
  }
}

/**
 * Google Calendar connector. Extends BaseOAuth2Client for token management.
 * Live calendar API calls (listEvents/createEvent/updateEvent/deleteEvent) are wired
 * by WP4 — see the throws below. WP2 wires ONLY the OAuth token lifecycle
 * (refreshToken) so getAccessToken()'s single-flight refresh works end to end.
 */
export class GoogleCalendarConnector extends BaseOAuth2Client {
  readonly provider = 'google';
  readonly account: string;

  /**
   * Override the MCP session transport (tests inject a fake connectionFactory / a stub
   * session). Production leaves this undefined and a real session is lazily constructed
   * for `this.account`.
   */
  private readonly sessionFactory?: () => McpGoogleSession;
  private _session?: McpGoogleSession;

  constructor(account: string, opts?: { sessionFactory?: () => McpGoogleSession }) {
    super();
    this.account = account;
    this.sessionFactory = opts?.sessionFactory;
  }

  /**
   * Lazily build (and hold) the McpGoogleSession for this connector's account. The
   * session owns ALL token/refresh logic via its internal TokenBearer (keyed on
   * provider/account) — we deliberately do NOT call getAccessToken() here, so refresh
   * stays single-sourced in base.ts / WP3 and never duplicated.
   */
  private session(): McpGoogleSession {
    if (!this._session) {
      this._session = this.sessionFactory
        ? this.sessionFactory()
        : new McpGoogleSession({ account: this.account, provider: this.provider });
    }
    return this._session;
  }

  /**
   * List events via the MCP session, mapping the provider envelope into RemoteEvents.
   * Cancelled/removed events surface with `deleted: true` (R3) so WP5's incremental
   * delete-sweep has a real tombstone signal. ISO-UTC start/end and etag pass through
   * the session's mapper; allDay is inferred from a date-only start. nextSyncToken /
   * expired are passed through unchanged.
   */
  async listEvents(opts?: ListEventsOpts): Promise<ListEventsResult> {
    const res = await this.session().listEvents({
      ...(opts?.from ? { from: opts.from } : {}),
      ...(opts?.to ? { to: opts.to } : {}),
      ...(opts?.syncToken ? { syncToken: opts.syncToken } : {}),
    });
    return {
      events: res.events.map(normalizeRemoteEvent),
      nextSyncToken: res.nextSyncToken ?? null,
      ...(res.expired !== undefined ? { expired: res.expired } : {}),
    };
  }

  /**
   * Create a provider event. When idempotencyKey is present we derive a deterministic
   * provider id (`cp` + base32hex(rawBytes)) and pass it through, so a retried create
   * reuses the SAME event. A 409 (duplicate id) is mapped to a read-back: fetch the
   * existing event by that id and return it, so the retry is idempotent (I7). With no
   * idempotencyKey, the provider mints the id.
   */
  async createEvent(input: RemoteEventInput): Promise<RemoteEvent> {
    const id = input.idempotencyKey ? providerEventId(input.idempotencyKey) : undefined;
    try {
      const created = await this.session().createEvent({
        ...input,
        ...(id ? { idempotencyKey: id } : {}),
      });
      return normalizeRemoteEvent(created);
    } catch (err) {
      if (id && statusOf(err) === 409) {
        // Duplicate id — a previous create already landed. Read it back so the retry is
        // a no-op that returns the canonical { id, etag }.
        const existing = await this.readBack(id);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Update a provider event with optimistic concurrency. A 412 / etag-mismatch is
   * translated to EtagConflictError(externalId, freshEtag) so the caller can resolve
   * remote-wins. The fresh etag is taken from the error/response when available, else null.
   */
  async updateEvent(externalId: string, input: RemoteEventInput, ifMatch: string | null): Promise<RemoteEvent> {
    try {
      const updated = await this.session().updateEvent(externalId, input, ifMatch);
      return normalizeRemoteEvent(updated);
    } catch (err) {
      if (statusOf(err) === 412) {
        throw new EtagConflictError(externalId, freshEtagOf(err));
      }
      throw err;
    }
  }

  /**
   * Delete a provider event. A 412 etag-mismatch → EtagConflictError. A 404/410 (already
   * gone) resolves successfully — delete is idempotent so a re-run after a partial sweep
   * doesn't error. Returns void.
   */
  async deleteEvent(externalId: string, ifMatch: string | null): Promise<void> {
    try {
      await this.session().deleteEvent(externalId, ifMatch);
    } catch (err) {
      const status = statusOf(err);
      if (status === 412) throw new EtagConflictError(externalId, freshEtagOf(err));
      if (status === 404 || status === 410) return; // already gone — idempotent
      throw err;
    }
  }

  /**
   * Read a single event back by provider id (used by the createEvent 409 echo-guard).
   * Returns undefined if the event can't be found / the read itself is unavailable —
   * the caller then re-throws the original 409.
   */
  private async readBack(id: string): Promise<RemoteEvent | undefined> {
    try {
      const { events } = await this.session().listEvents({});
      const found = events.find((e) => e.id === id);
      return found ? normalizeRemoteEvent(found) : undefined;
    } catch (err) {
      if (err instanceof McpUnavailable) return undefined;
      throw err;
    }
  }

  /**
   * Exchange a refresh token for a fresh access token (OAuth 2 refresh grant). POSTs
   * `grant_type=refresh_token` urlencoded to config.google.tokenUri; client_secret is
   * included only when configured. The refresh token itself is preserved by the base
   * class via mergeRefreshToken (Google omits it on refresh). A 400 `invalid_grant`
   * means the grant was revoked → RevokedTokenError so callers can flag re-auth (I*).
   */
  protected async refreshToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: string }> {
    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    };
    if (config.google.clientId) params.client_id = config.google.clientId;
    if (config.google.clientSecret) params.client_secret = config.google.clientSecret;

    const res = await postToken(params);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 400 && /invalid_grant/.test(text)) {
        throw new RevokedTokenError();
      }
      throw new Error(`Google token refresh failed (${res.status})`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('Google token refresh returned no access_token');
    const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString();
    return { accessToken: json.access_token, expiresAt };
  }
}
