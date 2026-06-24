import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { GoogleCalendarConnector } from './google.js';
import type { CalendarConnector } from './base.js';

export { BaseOAuth2Client } from './base.js';
export { GoogleCalendarConnector } from './google.js';
export { FixtureConnector } from './fixture.js';
export { EtagConflictError } from './base.js';
export type { CalendarConnector, RemoteEvent, RemoteEventInput } from './base.js';

/**
 * Return all active connectors for the current owner, one per connection_tokens row.
 * Returns an empty array when no tokens are stored — sync becomes a no-op.
 */
export function getConnectors(): CalendarConnector[] {
  const ownerId = currentOwnerId();
  let rows: { provider: string; account: string }[];
  try {
    rows = sqlite
      .prepare('SELECT provider, account FROM connection_tokens WHERE owner_id = ?')
      .all(ownerId) as { provider: string; account: string }[];
  } catch {
    return [];
  }
  return rows.flatMap(({ provider, account }) => {
    switch (provider) {
      case 'google':  return [new GoogleCalendarConnector(account)];
      default: return [];
    }
  });
}
