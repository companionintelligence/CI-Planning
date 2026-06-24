import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { McpGoogleSession, McpUnavailable, type McpConnectionFactory } from './client.js';
import { config } from '../lib/config.js';

/** Normalized Gmail message — shape the ingestion agent consumes. */
export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string; // ISO
  labels?: string[];
}

/** Normalized Google Calendar event. */
export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  start: string; // ISO
  end: string; // ISO
  location?: string;
  attendees?: string[];
}

export interface GoogleClient {
  readonly mode: 'fixture' | 'live';
  listEmails(opts?: { since?: string; limit?: number }): Promise<EmailMessage[]>;
  listEvents(opts?: { from?: string; to?: string; limit?: number }): Promise<CalendarEvent[]>;
}

const _dir = dirname(fileURLToPath(import.meta.url));
// server/src/mcp → server/test/fixtures
const defaultFixturesDir = join(_dir, '..', '..', 'test', 'fixtures');

function fixturesDir(): string {
  return process.env.CP_FIXTURES_DIR ?? defaultFixturesDir;
}

function loadFixture<T>(name: string): T[] {
  const path = join(fixturesDir(), name);
  if (!existsSync(path)) {
    logger.warn('fixture not found', { path });
    return [];
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T[];
  } catch (err) {
    logger.error('failed to parse fixture', { path, err: (err as Error).message });
    return [];
  }
}

/**
 * Fixture-backed Google client. Reads emails.json / calendar.json from the fixtures dir.
 * This is the default in dev and test so the whole ingestion pipeline runs without OAuth.
 */
export function createFixtureGoogleClient(): GoogleClient {
  return {
    mode: 'fixture',
    async listEmails(opts = {}) {
      let emails = loadFixture<EmailMessage>('emails.json');
      if (opts.since) emails = emails.filter((e) => e.receivedAt >= opts.since!);
      return opts.limit ? emails.slice(0, opts.limit) : emails;
    },
    async listEvents(opts = {}) {
      let events = loadFixture<CalendarEvent>('calendar.json');
      if (opts.from) events = events.filter((e) => e.start >= opts.from!);
      if (opts.to) events = events.filter((e) => e.start <= opts.to!);
      return opts.limit ? events.slice(0, opts.limit) : events;
    },
  };
}

/** Options for the live client (tests inject the MCP account + a fake transport). */
export interface LiveGoogleClientOpts {
  /** Connected Google account (the connection_tokens.account). Defaults to env. */
  account?: string;
  /** Inject a fake MCP connection (no spawn/network in CI). Defaults to a real stdio spawn. */
  connectionFactory?: McpConnectionFactory;
  /** Override the MCP command (defaults to config.google.mcp.command). */
  command?: string;
}

/**
 * Live client over a real MCP session (Gmail + Google Calendar MCP servers via the MCP
 * TypeScript SDK, stdio transport). Maps MCP results into EmailMessage / CalendarEvent.
 *
 * Fail-closed: on ANY transport failure it throws McpUnavailable — there is NO silent
 * fixture fallback in live mode (a degraded live connector that quietly serves stale
 * fixtures is worse than a loud failure callers can catch and degrade explicitly).
 */
export function createLiveGoogleClient(opts: LiveGoogleClientOpts = {}): GoogleClient {
  const account = opts.account ?? process.env.CP_GOOGLE_ACCOUNT ?? 'primary';
  const session = new McpGoogleSession({
    account,
    connectionFactory: opts.connectionFactory,
    command: opts.command,
  });
  return {
    mode: 'live',
    async listEmails(o = {}) {
      const rows = await session.listEmails({ since: o.since, limit: o.limit });
      return rows.map((m) => ({
        id: m.id,
        from: m.from,
        subject: m.subject,
        body: m.body,
        receivedAt: m.receivedAt,
        ...(m.labels ? { labels: m.labels } : {}),
      }));
    },
    async listEvents(o = {}) {
      const { events } = await session.listEvents({ from: o.from, to: o.to });
      const mapped: CalendarEvent[] = events.map((e) => ({
        id: e.id,
        title: e.title,
        description: '',
        start: e.start,
        end: e.end,
      }));
      return o.limit ? mapped.slice(0, o.limit) : mapped;
    },
  };
}

/** Factory: honors GOOGLE_MODE env ("live" | "fixture"), defaults to fixture. */
export function createGoogleClient(): GoogleClient {
  return config.google.mode === 'live' ? createLiveGoogleClient() : createFixtureGoogleClient();
}

export { McpUnavailable } from './client.js';
