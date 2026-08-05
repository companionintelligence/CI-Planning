import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { seal, open, loadKek } from '../lib/crypto/index.js';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';
import { BaseOAuth2Client } from '../connectors/base.js';
import { GoogleCalendarConnector } from '../connectors/google.js';
import type { RemoteEvent, RemoteEventInput } from '../connectors/base.js';

/**
 * Thrown when the Google MCP transport is unreachable, a required tool is missing, a
 * call times out / exhausts retries, auth cannot be recovered (second 401), or the
 * circuit breaker is open. Mirrors OllamaUnavailable so ingest/sync callers degrade
 * the same way (catch by name, fall back / skip rather than crash).
 */
export class McpUnavailable extends Error {
  /** Upstream HTTP-ish status when one could be determined (0/undefined when not). */
  readonly status?: number;
  /**
   * The provider's CURRENT etag for the contested resource, when a 412 surfaced one.
   *
   * This exists because every provider error is funnelled through this class: callers
   * only ever see an McpUnavailable, so anything not copied onto it is lost. The etag
   * is what lets an outbound conflict converge — without it `agents/sync.ts` records
   * the conflict but can never refresh the stored etag, so the next push re-conflicts
   * with the same stale value and the row never resolves.
   */
  readonly freshEtag?: string | null;

  constructor(message: string, opts: { status?: number; freshEtag?: string | null } = {}) {
    super(message);
    this.name = 'McpUnavailable';
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.freshEtag !== undefined) this.freshEtag = opts.freshEtag;
  }
}

/** The MCP tool names this client depends on, grouped by surface. */
export const REQUIRED_TOOLS = {
  calendar: {
    list: 'calendar_list_events',
    create: 'calendar_create_event',
    update: 'calendar_update_event',
    delete: 'calendar_delete_event',
  },
  gmail: {
    list: 'gmail_list_messages',
    get: 'gmail_get_message',
    modifyLabels: 'gmail_modify_labels',
  },
} as const;

/** Env var the spawned MCP server reads the OAuth bearer token from. */
export const MCP_TOKEN_ENV = 'GOOGLE_ACCESS_TOKEN';

/**
 * A minimal MCP client surface — just the pieces McpGoogleSession drives. The real
 * SDK Client satisfies this; tests inject a fake that records calls without a real
 * spawn or network.
 */
export interface McpClientLike {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * How a session obtains a connected transport + client. Production builds a real
 * StdioClientTransport from `command` + the minimal `env` (PATH + token ONLY) and a
 * real SDK Client. Tests inject a factory returning a fake that never spawns.
 */
export interface McpConnection {
  client: McpClientLike;
  transport: Transport;
  /** The env actually handed to the transport — surfaced so tests can assert I6. */
  env: Record<string, string>;
  /** The argv actually handed to the transport — surfaced so tests can assert no token leaks. */
  args: string[];
}

export interface McpConnectParams {
  command: string;
  /** Bearer token — placed in env ONLY, never argv, never logs. */
  accessToken: string;
  ownerId: string;
  provider: string;
  account: string;
}

export type McpConnectionFactory = (params: McpConnectParams) => McpConnection;

/**
 * Build the MINIMAL child env for the spawned MCP server: PATH (so the executable
 * resolves) plus the bearer token. We deliberately do NOT spread process.env — the
 * child has no business seeing CP_KEK_B64, DB_PATH, or anything else. The token lives
 * only here, never in argv.
 */
function minimalEnv(accessToken: string): Record<string, string> {
  const env: Record<string, string> = { [MCP_TOKEN_ENV]: accessToken };
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

/** Default production factory: a real stdio transport over the configured command. */
const defaultConnectionFactory: McpConnectionFactory = ({ command, accessToken }) => {
  if (!command) {
    throw new McpUnavailable('No MCP command configured (CP_MCP_COMMAND is empty)');
  }
  // Allow "node path/to/server.js arg" style commands; first token is the executable.
  const [bin, ...args] = command.split(/\s+/).filter(Boolean);
  const env = minimalEnv(accessToken);
  const transport = new StdioClientTransport({ command: bin, args, env });
  const client = new Client(
    { name: 'companion-planning', version: '0.2.0' },
    { capabilities: {} },
  ) as unknown as McpClientLike;
  return { client, transport, env, args };
};

/** Sleep that resolves after `ms` (used by the retry backoff). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Classify an error / tool result into an HTTP-ish status so the retry policy can
 * decide. Google's MCP servers surface upstream Google API status either as a numeric
 * `status`/`code` on a thrown error or embedded in the error message. We extract the
 * first plausible 3-digit HTTP code; unknown → 0 (treated as a non-retryable transport
 * fault, except AbortError which the caller maps to a timeout).
 */
export function classifyStatus(err: unknown): number {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.status === 'number') return o.status;
    if (typeof o.httpStatus === 'number') return o.httpStatus as number;
    const msg = typeof o.message === 'string' ? o.message : '';
    const m = msg.match(/\b(4\d\d|5\d\d)\b/);
    if (m) return Number(m[1]);
  }
  return 0;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Tool results can flag failure via `isError`; pull a status out of the text payload. */
function statusFromToolResult(result: unknown): number {
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (o.isError) {
      const content = Array.isArray(o.content) ? o.content : [];
      const text = content
        .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
        .join(' ');
      const m = text.match(/\b(4\d\d|5\d\d)\b/);
      return m ? Number(m[1]) : 599; // isError with no parseable code → treat as 5xx
    }
  }
  return 0;
}

/**
 * Best-effort extraction of the provider's current etag from a failed call, so a 412
 * can be resolved instead of merely counted.
 *
 * Checked in order of trustworthiness: a structured `freshEtag`/`etag` property on the
 * error, then the same keys inside an MCP tool-result payload, and finally a regex over
 * whatever text we have (the stdio MCP servers commonly stringify the upstream Google
 * error rather than modelling it). Returns null when nothing credible is present —
 * callers must treat null as "unknown", never as "no etag".
 */
export function etagFromFailure(err: unknown, result?: unknown): string | null {
  const fromObject = (v: unknown): string | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (typeof o.freshEtag === 'string' && o.freshEtag) return o.freshEtag;
    if (typeof o.etag === 'string' && o.etag) return o.etag;
    return null;
  };

  const direct = fromObject(err) ?? fromObject(result) ?? fromObject(structuredOf(result));
  if (direct) return direct;

  const texts: string[] = [];
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    texts.push((err as { message: string }).message);
  }
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && typeof c === 'object' && 'text' in c) texts.push(String((c as { text: unknown }).text));
      }
    }
  }
  for (const t of texts) {
    // Matches "etag":"\"abc\"" / etag: 'abc' / etag=abc — the quoting varies by server.
    const m = t.match(/["']?(?:fresh)?etag["']?\s*[:=]\s*["']([^"']+)["']/i);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Circuit-breaker phases. */
type BreakerState = 'closed' | 'open' | 'half-open';

interface BreakerConfig {
  threshold: number;
  cooldownMs: number;
}

function breakerConfig(): BreakerConfig {
  return {
    threshold: Number(process.env.CP_MCP_BREAKER_THRESHOLD ?? 5),
    cooldownMs: Number(process.env.CP_MCP_BREAKER_COOLDOWN_MS ?? 30_000),
  };
}

/**
 * Token bearer that REUSES BaseOAuth2Client's decrypt + single-flight refresh. The
 * provider refresh call itself is delegated to the real GoogleCalendarConnector so
 * production hits the real Google token endpoint (WP2's refreshToken). `forceRefresh`
 * (the 401 path) marks the stored token expired and re-reads through getAccessToken —
 * so the forced refresh flows through base.ts's single-flight gate keyed by
 * (owner,provider,account). Concurrent forced refreshes therefore share ONE provider
 * refresh (R2).
 */
class TokenBearer extends BaseOAuth2Client {
  readonly provider: string;
  readonly account: string;
  private readonly delegate: GoogleCalendarConnector;

  constructor(provider: string, account: string) {
    super();
    this.provider = provider;
    this.account = account;
    this.delegate = new GoogleCalendarConnector(account);
  }

  /** Public accessor over the protected base method (decrypt + refresh-if-expired). */
  token(): Promise<string> {
    return this.getAccessToken();
  }

  /**
   * Force a refresh: expire the stored token in place, then read it back. The
   * re-read sees an expired token and routes through BaseOAuth2Client's single-flight
   * refresh — so this never duplicates a refresh path and coalesces with any
   * concurrent forced refresh for the same (owner,provider,account).
   */
  async forceRefresh(): Promise<string> {
    const ownerId = currentOwnerId();
    const kek = await loadKek();
    const row = await store()
      .prepare(
        'SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?',
      )
      .get<{ iv: string; auth_tag: string; ciphertext: string }>(ownerId, this.provider, this.account);
    if (!row) throw new McpUnavailable(`No connection token for ${this.provider}/${this.account}`);
    const tok = JSON.parse(
      open({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, kek),
    ) as { accessToken: string; refreshToken: string; expiresAt: string };
    // Only rewrite the expiry if it isn't already in the past — avoids a write race
    // when two forced refreshes land together; whichever sees it still-valid expires
    // it, the other no-ops, and both then share the single-flight refresh.
    if (new Date(tok.expiresAt) > new Date()) {
      const sealed = seal(
        JSON.stringify({ ...tok, expiresAt: '1970-01-01T00:00:00.000Z' }),
        kek,
      );
      await store()
        .prepare(
          `UPDATE connection_tokens SET iv = ?, auth_tag = ?, ciphertext = ?
           WHERE owner_id = ? AND provider = ? AND account = ?`,
        )
        .run(sealed.iv, sealed.authTag, sealed.ciphertext, ownerId, this.provider, this.account);
    }
    return this.getAccessToken();
  }

  protected refreshToken(rt: string): Promise<{ accessToken: string; expiresAt: string }> {
    // Reach the protected refreshToken on the real connector via a thin shim so the
    // provider-specific refresh (WP2) is the single implementation.
    return (this.delegate as unknown as {
      refreshToken(rt: string): Promise<{ accessToken: string; expiresAt: string }>;
    }).refreshToken(rt);
  }

  // The CalendarConnector surface is unused on the bearer — all real calls go through
  // the MCP session. These satisfy the abstract contract only.
  async listEvents(): Promise<never> {
    throw new Error('TokenBearer.listEvents is not a transport path');
  }
  async createEvent(): Promise<never> {
    throw new Error('TokenBearer.createEvent is not a transport path');
  }
  async updateEvent(): Promise<never> {
    throw new Error('TokenBearer.updateEvent is not a transport path');
  }
  async deleteEvent(): Promise<never> {
    throw new Error('TokenBearer.deleteEvent is not a transport path');
  }
}

export interface McpGoogleSessionOpts {
  ownerId?: string;
  provider?: string;
  account: string;
  /** Override the transport factory (tests inject a fake; defaults to a real stdio spawn). */
  connectionFactory?: McpConnectionFactory;
  /** Override the MCP command (defaults to config.google.mcp.command). */
  command?: string;
  /** Per-call timeout (ms). Defaults to config.google.mcp.timeoutMs. */
  timeoutMs?: number;
  /** Max retries on 429/5xx. Defaults to config.google.mcp.retries. */
  retries?: number;
}

/** A connected MCP child + its negotiated tool set. */
interface ActiveConnection {
  conn: McpConnection;
  tools: Set<string>;
}

/**
 * The single MCP transport layer every Google call sits on. Constructed per
 * (ownerId, provider, account). Owns: spawning the MCP child (token in env only),
 * tool-contract assertion, per-call timeout, retry with backoff+jitter, the one-shot
 * 401 → forced-refresh → respawn → retry, and a circuit breaker. WP4/WP8 consume only
 * the typed Calendar / Gmail wrappers below.
 */
export class McpGoogleSession {
  readonly ownerId: string;
  readonly provider: string;
  readonly account: string;

  private readonly bearer: TokenBearer;
  private readonly connectionFactory: McpConnectionFactory;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  private active: ActiveConnection | null = null;
  /** Single-flight spawn so concurrent callers share one child + one handshake. */
  private spawning: Promise<ActiveConnection> | null = null;
  /** Single-flight forced-refresh+respawn so concurrent 401s share ONE recovery (R2). */
  private recovering: Promise<ActiveConnection> | null = null;

  // Circuit breaker.
  private breaker: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(opts: McpGoogleSessionOpts) {
    this.ownerId = opts.ownerId ?? currentOwnerId();
    this.provider = opts.provider ?? 'google';
    this.account = opts.account;
    this.bearer = new TokenBearer(this.provider, this.account);
    this.connectionFactory = opts.connectionFactory ?? defaultConnectionFactory;
    this.command = opts.command ?? config.google.mcp.command;
    this.timeoutMs = opts.timeoutMs ?? config.google.mcp.timeoutMs;
    this.retries = opts.retries ?? config.google.mcp.retries;
  }

  /** Spawn the child, complete the MCP handshake, and pin the tool contract. */
  private async spawn(forceRefresh = false): Promise<ActiveConnection> {
    const accessToken = forceRefresh ? await this.bearer.forceRefresh() : await this.bearer.token();
    const conn = this.connectionFactory({
      command: this.command,
      accessToken,
      ownerId: this.ownerId,
      provider: this.provider,
      account: this.account,
    });

    // Defense in depth: a misbuilt factory must never leak the token into argv.
    if (conn.args.some((a) => a.includes(accessToken))) {
      throw new McpUnavailable('MCP transport args contain the access token (refusing to spawn)');
    }

    try {
      await conn.client.connect(conn.transport);
    } catch (err) {
      throw new McpUnavailable(`MCP connect failed: ${(err as Error).message}`);
    }

    let listed: { tools: { name: string }[] };
    try {
      listed = await conn.client.listTools();
    } catch (err) {
      await this.safeClose(conn);
      throw new McpUnavailable(`MCP listTools failed: ${(err as Error).message}`);
    }
    const tools = new Set(listed.tools.map((t) => t.name));

    // Calendar tools are ALWAYS required. Gmail tools are required ONLY when Gmail
    // ingest is enabled (config.google.enableGmail). The recommended first live rung is
    // calendar-only (Gmail's restricted scope needs a CASA assessment — see the runbook),
    // and that deployment's MCP server exposes only the 4 calendar tools. Asserting the
    // Gmail tools unconditionally would reject it and break calendar sync entirely.
    const requiredTools = [
      ...Object.values(REQUIRED_TOOLS.calendar),
      ...(config.google.enableGmail ? Object.values(REQUIRED_TOOLS.gmail) : []),
    ];
    for (const name of requiredTools) {
      if (!tools.has(name)) {
        await this.safeClose(conn);
        throw new McpUnavailable(`Required MCP tool missing: ${name}`);
      }
    }

    logger.info('MCP Google session ready', {
      provider: this.provider,
      account: this.account,
      tools: tools.size,
    });
    return { conn, tools };
  }

  /** Lazily spawn (single-flight) and return the active connection. */
  private async ensureConnection(): Promise<ActiveConnection> {
    if (this.active) return this.active;
    if (!this.spawning) {
      this.spawning = this.spawn(false)
        .then((a) => {
          this.active = a;
          return a;
        })
        .finally(() => {
          this.spawning = null;
        });
    }
    return this.spawning;
  }

  /**
   * One-shot auth recovery: forced refresh → respawn → retry. Single-flight per
   * session so concurrent 401s coalesce into ONE forced refresh + ONE respawn (R2).
   */
  private async recover(): Promise<ActiveConnection> {
    if (!this.recovering) {
      const prev = this.active;
      this.active = null;
      this.recovering = (async () => {
        if (prev) await this.safeClose(prev.conn);
        const a = await this.spawn(true);
        this.active = a;
        return a;
      })().finally(() => {
        this.recovering = null;
      });
    }
    return this.recovering;
  }

  private async safeClose(conn: McpConnection): Promise<void> {
    try {
      await conn.client.close();
    } catch {
      /* best-effort */
    }
  }

  private checkBreaker(): void {
    if (this.breaker === 'open') {
      const { cooldownMs } = breakerConfig();
      if (Date.now() - this.openedAt >= cooldownMs) {
        this.breaker = 'half-open';
        logger.warn('MCP circuit breaker half-open', { provider: this.provider, account: this.account });
      } else {
        throw new McpUnavailable('MCP circuit breaker is open');
      }
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.breaker !== 'closed') {
      this.breaker = 'closed';
      logger.info('MCP circuit breaker closed', { provider: this.provider, account: this.account });
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    const { threshold } = breakerConfig();
    if (this.consecutiveFailures >= threshold) {
      this.breaker = 'open';
      this.openedAt = Date.now();
      logger.warn('MCP circuit breaker opened', {
        provider: this.provider,
        account: this.account,
        failures: this.consecutiveFailures,
      });
    }
  }

  /**
   * Invoke a tool with the full reliability envelope: circuit-breaker gate, per-call
   * AbortController timeout, exponential backoff + jitter on 429/5xx up to
   * config.google.mcp.retries, and a one-shot 401 → forced refresh → respawn → retry
   * (a second 401 throws McpUnavailable). 4xx (other than 401) is not retried.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.checkBreaker();
    const { timeoutMs, retries } = this;
    let attempt = 0;
    let authRetried = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { conn } = await this.ensureConnection();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await conn.client.callTool({ name, arguments: args }, undefined, {
          signal: controller.signal,
          timeout: timeoutMs,
        });
        // Tool-level error surfaced via isError → treat like an HTTP status.
        const toolStatus = statusFromToolResult(result);
        if (toolStatus) {
          // Carry the etag off the result and onto the error — this is the only point
          // where the payload is still in scope, and a 412's whole value is that etag.
          throw Object.assign(new Error(`MCP tool ${name} returned error status ${toolStatus}`), {
            status: toolStatus,
            freshEtag: etagFromFailure(result, result),
          });
        }
        this.recordSuccess();
        return result;
      } catch (err) {
        // Aborted by our timer → a per-call timeout.
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
          this.recordFailure();
          throw new McpUnavailable(`MCP tool ${name} timed out after ${timeoutMs}ms`);
        }
        if (err instanceof McpUnavailable) {
          this.recordFailure();
          throw err;
        }

        const status = classifyStatus(err);

        // 401 → one-shot forced refresh + respawn + retry. A second 401 is fatal.
        if (status === 401) {
          if (authRetried) {
            this.recordFailure();
            throw new McpUnavailable(`MCP tool ${name} failed: unauthorized after token refresh`);
          }
          authRetried = true;
          await this.recover();
          continue; // retry once with the refreshed token / new child
        }

        // Retryable transient (429 / 5xx): backoff + jitter, up to `retries`.
        if (isRetryableStatus(status) && attempt < retries) {
          const base = Math.min(1000 * 2 ** attempt, 8000);
          const delay = base / 2 + Math.random() * (base / 2);
          attempt++;
          await sleep(delay);
          continue;
        }

        // Non-retryable (4xx other than 401, or exhausted retries). Propagate the status
        // and any fresh etag: this class is the ONLY error callers see, so whatever
        // isn't copied here is gone (connectors/google.ts maps 412 → EtagConflictError
        // and needs the etag to let the conflict converge).
        this.recordFailure();
        const freshEtag = etagFromFailure(err);
        if (isRetryableStatus(status)) {
          throw new McpUnavailable(`MCP tool ${name} failed after ${retries} retries (status ${status})`, {
            status,
            freshEtag,
          });
        }
        throw new McpUnavailable(
          `MCP tool ${name} failed (status ${status || 'unknown'}): ${(err as Error).message}`,
          { status, freshEtag },
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** Tear down the child process. Idempotent. */
  async close(): Promise<void> {
    const a = this.active;
    this.active = null;
    if (a) await this.safeClose(a.conn);
  }

  // ---- Calendar wrappers (RemoteEvent-shaped, etag passthrough) — consumed by WP4 ----

  async listEvents(opts: { from?: string; to?: string; syncToken?: string } = {}): Promise<{
    events: RemoteEvent[];
    nextSyncToken?: string | null;
    expired?: boolean;
  }> {
    const raw = await this.callTool(REQUIRED_TOOLS.calendar.list, {
      ...(opts.from ? { timeMin: opts.from } : {}),
      ...(opts.to ? { timeMax: opts.to } : {}),
      ...(opts.syncToken ? { syncToken: opts.syncToken } : {}),
    });
    const data = structuredOf(raw) as {
      events?: unknown[];
      nextSyncToken?: string | null;
      expired?: boolean;
    };
    return {
      events: (data.events ?? []).map(toRemoteEvent),
      nextSyncToken: data.nextSyncToken ?? null,
      expired: data.expired ?? false,
    };
  }

  async createEvent(input: RemoteEventInput): Promise<RemoteEvent> {
    const raw = await this.callTool(REQUIRED_TOOLS.calendar.create, {
      title: input.title,
      start: input.start,
      end: input.end,
      ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return toRemoteEvent(structuredOf(raw));
  }

  async updateEvent(
    externalId: string,
    input: RemoteEventInput,
    ifMatch: string | null,
  ): Promise<RemoteEvent> {
    const raw = await this.callTool(REQUIRED_TOOLS.calendar.update, {
      id: externalId,
      title: input.title,
      start: input.start,
      end: input.end,
      ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      ifMatch,
    });
    return toRemoteEvent(structuredOf(raw));
  }

  async deleteEvent(externalId: string, ifMatch: string | null): Promise<void> {
    await this.callTool(REQUIRED_TOOLS.calendar.delete, { id: externalId, ifMatch });
  }

  // ---- Gmail wrappers — consumed by WP8 ----

  async listEmails(opts: { query?: string; since?: string; limit?: number } = {}): Promise<RawGmailMessage[]> {
    const raw = await this.callTool(REQUIRED_TOOLS.gmail.list, {
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.since ? { since: opts.since } : {}),
      ...(opts.limit ? { maxResults: opts.limit } : {}),
    });
    const data = structuredOf(raw) as { messages?: unknown[] };
    return (data.messages ?? []).map(toRawGmail);
  }

  async getEmail(id: string): Promise<RawGmailMessage> {
    const raw = await this.callTool(REQUIRED_TOOLS.gmail.get, { id });
    return toRawGmail(structuredOf(raw));
  }

  async labelEmail(id: string, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    await this.callTool(REQUIRED_TOOLS.gmail.modifyLabels, {
      id,
      addLabelIds: opts.add ?? [],
      removeLabelIds: opts.remove ?? [],
    });
  }
}

/** Normalized Gmail row the GoogleClient maps into EmailMessage. */
export interface RawGmailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  labels?: string[];
}

/**
 * Pull the structured payload out of a callTool result. MCP tools return either
 * `structuredContent` (preferred) or a single JSON text block; fall back to the raw
 * object so a fake transport can hand back a plain object directly.
 */
function structuredOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (o.structuredContent && typeof o.structuredContent === 'object') {
      return o.structuredContent as Record<string, unknown>;
    }
    if (Array.isArray(o.content)) {
      const textBlock = o.content.find(
        (c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text',
      ) as { text?: string } | undefined;
      if (textBlock?.text) {
        try {
          return JSON.parse(textBlock.text) as Record<string, unknown>;
        } catch {
          /* not JSON — fall through */
        }
      }
    }
    return o;
  }
  return {};
}

function toRemoteEvent(v: unknown): RemoteEvent {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    title: String(o.title ?? o.summary ?? ''),
    start: String(o.start ?? ''),
    end: String(o.end ?? ''),
    etag: o.etag === undefined || o.etag === null ? null : String(o.etag),
    ...(o.allDay !== undefined ? { allDay: Boolean(o.allDay) } : {}),
    ...(o.deleted !== undefined ? { deleted: Boolean(o.deleted) } : {}),
  };
}

function toRawGmail(v: unknown): RawGmailMessage {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    from: String(o.from ?? ''),
    subject: String(o.subject ?? ''),
    body: String(o.body ?? ''),
    receivedAt: String(o.receivedAt ?? o.internalDate ?? ''),
    ...(Array.isArray(o.labels) ? { labels: (o.labels as unknown[]).map(String) } : {}),
  };
}
