import type { RemoteEvent, RemoteEventInput, ListEventsResult, ListEventsOpts } from './base.js';
import { BaseOAuth2Client } from './base.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

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

  constructor(account: string) {
    super();
    this.account = account;
  }

  async listEvents(_opts?: ListEventsOpts): Promise<ListEventsResult> {
    await this.getAccessToken();
    throw new Error('GoogleCalendarConnector.listEvents not yet wired — see mcp/google.ts TODO(phase-2)');
  }

  async createEvent(_input: RemoteEventInput): Promise<RemoteEvent> {
    await this.getAccessToken();
    throw new Error('GoogleCalendarConnector.createEvent not yet wired — see mcp/google.ts TODO(phase-2)');
  }

  async updateEvent(externalId: string, _input: RemoteEventInput, _ifMatch: string | null): Promise<RemoteEvent> {
    await this.getAccessToken();
    throw new Error(`GoogleCalendarConnector.updateEvent not yet wired (${externalId})`);
  }

  async deleteEvent(externalId: string, _ifMatch: string | null): Promise<void> {
    await this.getAccessToken();
    throw new Error(`GoogleCalendarConnector.deleteEvent not yet wired (${externalId})`);
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
