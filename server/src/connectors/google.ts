import type { RemoteEvent, RemoteEventInput, ListEventsResult, ListEventsOpts } from './base.js';
import { BaseOAuth2Client } from './base.js';

/**
 * Google Calendar connector. Extends BaseOAuth2Client for token management.
 * Live API calls are not yet wired — see mcp/google.ts TODO(phase-2).
 * The FixtureConnector is used for all tests.
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

  protected async refreshToken(_refreshToken: string): Promise<{ accessToken: string; expiresAt: string }> {
    throw new Error('GoogleCalendarConnector.refreshToken not yet wired');
  }
}
