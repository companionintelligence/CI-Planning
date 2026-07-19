import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { config } from '../lib/config.js';
import { GoogleCalendarConnector } from './google.js';
import type { CalendarConnector } from './base.js';

export { BaseOAuth2Client } from './base.js';
export { GoogleCalendarConnector, RevokedTokenError, revoke } from './google.js';
export { FixtureConnector } from './fixture.js';
export { EtagConflictError } from './base.js';
export type { CalendarConnector, RemoteEvent, RemoteEventInput, ListEventsResult, ListEventsOpts } from './base.js';

/**
 * Return all active connectors for the current owner, one per ACTIVE connection_tokens
 * row. Rows with status<>'active' (revoked / errored) are skipped so a disconnected or
 * broken connection never silently resumes syncing. Returns an empty array when no
 * active tokens are stored — sync becomes a no-op.
 */
/**
 * Active Google account names for the current owner (connection_tokens rows with
 * status='active'). Empty when nothing is connected — ingest becomes a no-op, the
 * same posture getConnectors() gives sync.
 */
export function googleAccounts(): string[] {
  // GOOGLE_MODE=off means OFF for stored connections too, not just new ones —
  // oauth /start gates connecting, this gates every already-connected account.
  if (config.google.mode === 'off') return [];
  const ownerId = currentOwnerId();
  try {
    const rows = sqlite
      .prepare(
        "SELECT account FROM connection_tokens WHERE owner_id = ? AND provider = 'google' AND status = 'active'",
      )
      .all(ownerId) as { account: string }[];
    return rows.map((r) => r.account);
  } catch {
    return [];
  }
}

export function getConnectors(): CalendarConnector[] {
  const ownerId = currentOwnerId();
  let rows: { provider: string; account: string }[];
  try {
    rows = sqlite
      .prepare("SELECT provider, account FROM connection_tokens WHERE owner_id = ? AND status = 'active'")
      .all(ownerId) as { provider: string; account: string }[];
  } catch {
    return [];
  }
  return rows.flatMap(({ provider, account }) => {
    switch (provider) {
      // Mode 'off' silences stored Google connections everywhere at this single choke
      // point — syncAll, enqueueOutbound, and pushOutboundDeletes all source from here,
      // so disabling the integration in Settings actually stops the 15-minute sync
      // instead of only blocking NEW connections (oauth /start's gate).
      case 'google':  return config.google.mode === 'off' ? [] : [new GoogleCalendarConnector(account)];
      default: return [];
    }
  });
}
