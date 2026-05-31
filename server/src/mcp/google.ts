import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';

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

/**
 * Live client placeholder. In production this connects to the Gmail / Google Calendar
 * MCP servers via the MCP TypeScript SDK (StreamableHTTP or stdio) and maps their
 * responses into EmailMessage / CalendarEvent. Until wired, it falls back to fixtures
 * so callers have a stable contract.
 *
 * TODO(phase-2): replace fixture fallback with real MCP client sessions + OAuth token
 * from the Keychain. See ARCHITECTURE.md §12.
 */
export function createLiveGoogleClient(): GoogleClient {
  logger.warn('Live Google MCP client not yet wired; using fixtures. See ARCHITECTURE.md §12.');
  const fb = createFixtureGoogleClient();
  return { ...fb, mode: 'live' };
}

/** Factory: honors GOOGLE_MODE env ("live" | "fixture"), defaults to fixture. */
export function createGoogleClient(): GoogleClient {
  return process.env.GOOGLE_MODE === 'live' ? createLiveGoogleClient() : createFixtureGoogleClient();
}
