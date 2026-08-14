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
  /**
   * Release the underlying transport. REQUIRED on the live path: each client owns an
   * McpGoogleSession that spawns a child process holding a live bearer token in its
   * env, and the scheduled ingest/sync jobs build a fresh client every cycle. Without
   * a close on the interface those children can never be reaped — they accumulate for
   * as long as the server runs. Idempotent, and a no-op for the fixture client.
   */
  close(): Promise<void>;
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

const DAY_MS = 86_400_000;

/**
 * Shift the committed email fixtures forward by a whole number of days, so the newest
 * always lands inside the last 24 hours.
 *
 * emails.json carries fixed dates, but the Gmail ingest window is relative to now: 0147
 * floors it at now − `email_lookback_days`, and the API caps that at 90. Left alone the
 * fixtures age past every legal setting and fixture mode silently ingests nothing — no
 * error, no suggestions, just a demo that quietly stopped working. These passed 90 days
 * old in August 2026, so this is not hypothetical.
 *
 * Whole days rather than an exact offset, so the result holds still for a day at a time:
 * each message keeps its time-of-day and the spacing between them, the gmail_since
 * watermark advances normally within a run instead of being outrun by a cursor that
 * creeps on every poll, and the set refreshes once daily. Ids are untouched, so the
 * dedupe key (source_ref) survives the shift — a refreshed message updates its existing
 * possible rather than duplicating it.
 *
 * Calendar fixtures are deliberately NOT rebased: ingestEvents passes no from/to, so
 * nothing filters them by date and they never expire this way.
 */
function rebaseEmailsToRecent(emails: EmailMessage[]): EmailMessage[] {
  const times = emails.map((e) => Date.parse(e.receivedAt)).filter((t) => Number.isFinite(t));
  if (!times.length) return emails;
  const shift = Math.floor((Date.now() - Math.max(...times)) / DAY_MS) * DAY_MS;
  if (shift <= 0) return emails; // already current, or dated ahead — leave them be
  return emails.map((e) => {
    const t = Date.parse(e.receivedAt);
    return Number.isFinite(t) ? { ...e, receivedAt: new Date(t + shift).toISOString() } : e;
  });
}

/**
 * Fixture-backed Google client. Reads emails.json / calendar.json from the fixtures dir.
 * This is the default in dev and test so the whole ingestion pipeline runs without OAuth.
 */
export function createFixtureGoogleClient(): GoogleClient {
  return {
    mode: 'fixture',
    async listEmails(opts = {}) {
      let emails = rebaseEmailsToRecent(loadFixture<EmailMessage>('emails.json'));
      if (opts.since) emails = emails.filter((e) => e.receivedAt >= opts.since!);
      return opts.limit ? emails.slice(0, opts.limit) : emails;
    },
    async listEvents(opts = {}) {
      let events = loadFixture<CalendarEvent>('calendar.json');
      if (opts.from) events = events.filter((e) => e.start >= opts.from!);
      if (opts.to) events = events.filter((e) => e.start <= opts.to!);
      return opts.limit ? events.slice(0, opts.limit) : events;
    },
    // Nothing to release — fixtures are plain file reads.
    async close() {},
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
    // Tears down the spawned MCP child. McpGoogleSession.close() is idempotent, so a
    // caller closing in a finally block is safe even if no call ever spawned one.
    close: () => session.close(),
  };
}

/**
 * Factory: honors GOOGLE_MODE ("live" | "fixture" | unset ⇒ off).
 *
 * `off` throws McpUnavailable rather than silently returning the fixture client —
 * fixture data must never reach a caller that didn't opt in (GOOGLE_MODE=fixture).
 * Callers already catch McpUnavailable and degrade.
 */
export function createGoogleClient(opts: { account?: string } = {}): GoogleClient {
  if (config.google.mode === 'live') return createLiveGoogleClient(opts);
  if (config.google.mode === 'fixture') return createFixtureGoogleClient();
  throw new McpUnavailable('Google integration is off (set GOOGLE_MODE=live or fixture)');
}

export { McpUnavailable };
