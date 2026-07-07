import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlite } from '../db/index.js';
import { config } from '../lib/config.js';
import { seal, open, loadKek } from '../lib/crypto/index.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';

/**
 * Phase AA · AA0 — CI-Server `companion-memory` connector (pull-first).
 *
 * Read-only client of the CI-Server memory API (GET /graph/context, /graph/search,
 * /graph/data). Auth follows the CI-Import-Tools pattern: `x-api-key` and
 * `Authorization: Bearer` may COEXIST on the same request; CI-Server's
 * JwtOrApiKeyAuthGuard resolves the user from whichever it accepts, so CP stays
 * stateless about the CI-Server user mapping.
 *
 * Creds are per-owner: a `connection_tokens` row (provider='ci_memory', KEK-encrypted
 * JSON `{ url, apiKey?, bearer? }`) wins; the CI_SERVER_URL / CI_SERVER_API_KEY env
 * pair is a dev/single-tenant convenience fallback only — it is IGNORED under
 * multi-tenant SSO (AUTH_MODE=sso without DISABLE_OIDC), because CI-Server's
 * ApiKeyStrategy derives the user from the key, so a shared env key would silently
 * map every owner onto ONE CI-Server identity. Env is read at CALL time (not via
 * the config singleton) so tests can toggle it — same precedent as mcp/google.ts
 * fixturesDir().
 *
 * Transport modes (MEMORY_MODE, default 'fixture'): fixture reads
 * server/fixtures/memory/graph.json and never touches the network — the same
 * offline-by-default posture as the Google fixture connector. NOTE: fixture mode is a
 * TRANSPORT switch only; availability (memoryConnectorAvailable) stays creds-driven in
 * both modes, so flag-off/no-creds behavior is identical across modes.
 *
 * Every transport/4xx/5xx failure surfaces as MemoryUnavailable so callers degrade
 * deterministically (the McpUnavailable / OllamaUnavailable contract).
 */

/** Thrown when CI-Server is unreachable / rejects the call. Callers catch and degrade. */
export class MemoryUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryUnavailable';
  }
}

export const MEMORY_PROVIDER = 'ci_memory';

export interface MemoryCreds {
  url: string;
  apiKey?: string;
  bearer?: string;
}

export type MemoryCredsSource = 'settings' | 'env';
/** How the settings connection authenticates: a manually-pasted key/bearer, or a
 *  CI-Portal SSO grant with a stored refresh token (AA0b). Null for the env fallback. */
export type MemoryAuthKind = 'manual' | 'oidc';

/**
 * The two shapes stored (KEK-encrypted) in connection_tokens for provider='ci_memory':
 *
 *  - manual (AA0): a pasted `apiKey`/`bearer` alongside the CI-Server `url`. `kind`
 *    is absent on legacy rows, so a missing discriminant reads as 'manual'.
 *  - oidc  (AA0b): a CI-Portal Authorization-Code + PKCE grant obtained with the
 *    `offline_access` scope. We persist the short-lived `accessToken` (sent to
 *    CI-Server as the Bearer), the long-lived `refreshToken`, its `expiresAt`, and
 *    the `tokenEndpoint`/`clientId`(/`clientSecret`) needed to self-refresh — so the
 *    connector never needs a re-login while the refresh token stays valid.
 */
interface ManualBlob {
  url: string;
  kind?: 'manual';
  apiKey?: string;
  bearer?: string;
}
interface OidcBlob {
  url: string;
  kind: 'oidc';
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
}
type MemoryBlob = ManualBlob | OidcBlob;

/** Refresh a hair EARLY so an in-flight request never races the expiry boundary. */
const REFRESH_SKEW_MS = 60_000;

/** Normalized graph node (CI-Server GraphController response shape, camelCased). */
export interface MemoryNode {
  id: string;
  entityType: string;
  name: string;
  description: string | null;
  properties: Record<string, unknown>;
}

/** Normalized graph relationship. */
export interface MemoryLink {
  id: string;
  source: string;
  target: string;
  relationshipType: string;
  strength: number;
  properties: Record<string, unknown>;
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  links: MemoryLink[];
}

export interface GraphDataFilters {
  from?: string; // ISO — events at/after this instant
  to?: string;   // ISO — events at/before this instant
  includeTypes?: string[];
}

/** Transport mode. Read per-call (tests flip it); default fixture = fully offline. */
export function memoryMode(): 'live' | 'fixture' {
  return process.env.MEMORY_MODE === 'live' ? 'live' : 'fixture';
}

/**
 * Resolve the owner's CI-Server creds: connection_tokens (provider='ci_memory',
 * status='active') → env fallback → null. A row that fails to decrypt (rotated or
 * missing KEK) degrades to the env fallback with a redacted warning — never a throw,
 * because this is the availability probe the status endpoint and the suggest agent gate on.
 *
 * The env fallback is SINGLE-TENANT ONLY (test / standalone / sso+DISABLE_OIDC local
 * login): under multi-tenant SSO it is skipped, since one shared CI_SERVER_API_KEY
 * would resolve every owner to the same CI-Server user.
 */
export type ResolvedMemoryCreds = MemoryCreds & { source: MemoryCredsSource; authKind: MemoryAuthKind | null };

/** Decrypt the owner's active ci_memory blob, or null (missing row / decrypt failure). */
function readMemoryBlob(owner: string): MemoryBlob | null {
  const row = sqlite
    .prepare(
      `SELECT iv, auth_tag, ciphertext FROM connection_tokens
        WHERE owner_id = ? AND provider = ? AND status = 'active'`,
    )
    .get(owner, MEMORY_PROVIDER) as { iv: string; auth_tag: string; ciphertext: string } | undefined;
  if (!row) return null;
  const parsed = JSON.parse(open({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, loadKek())) as MemoryBlob;
  return parsed.url ? parsed : null;
}

export function memoryCreds(owner: string): ResolvedMemoryCreds | null {
  try {
    const blob = readMemoryBlob(owner);
    if (blob) {
      // OIDC: the STORED access token is returned as the bearer WITHOUT a network
      // refresh — this is the sync availability/status probe. A live request path
      // (getJson → resolveLiveMemoryCreds) refreshes it when it's expiring.
      if (blob.kind === 'oidc') {
        return { url: blob.url, bearer: blob.accessToken, source: 'settings', authKind: 'oidc' };
      }
      return { url: blob.url, apiKey: blob.apiKey, bearer: blob.bearer, source: 'settings', authKind: 'manual' };
    }
  } catch (err) {
    // Decrypt/KEK failure → fall through to env. Never log ciphertext.
    logger.warn('memoryCreds: failed to open ci_memory token; falling back to env', {
      owner,
      err: (err as Error).message,
    });
  }
  // Multi-tenant SSO ⇒ no env fallback: creds must be connected per owner in Settings.
  if (config.auth.mode === 'sso' && !config.auth.disableOidc) return null;
  const url = process.env.CI_SERVER_URL;
  if (url) {
    return { url, apiKey: process.env.CI_SERVER_API_KEY || undefined, source: 'env', authKind: null };
  }
  return null;
}

/**
 * Store (or replace) the owner's CI-Server connection, KEK-encrypted. One logical
 * connection per owner: any previous ci_memory rows are deleted first, so a URL change
 * can't strand a stale row under a different `account`. Returns the account label
 * (the URL host) for display.
 */
export function storeMemoryConnection(owner: string, creds: MemoryCreds): string {
  const account = new URL(creds.url).host;
  const sealed = seal(JSON.stringify({ url: creds.url, apiKey: creds.apiKey, bearer: creds.bearer }), loadKek());
  sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM connection_tokens WHERE owner_id = ? AND provider = ?`).run(owner, MEMORY_PROVIDER);
    sqlite
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), owner, MEMORY_PROVIDER, account, sealed.iv, sealed.authTag, sealed.ciphertext);
  })();
  return account;
}

/**
 * AA0b — store (or replace) a CI-Portal SSO connection: the OIDC token set + the
 * bits needed to self-refresh. One logical connection per owner (prior ci_memory rows
 * are deleted first), same as {@link storeMemoryConnection}. Returns the account label.
 */
export interface MemoryOidcConnection {
  url: string; // CI-Server memory API base
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
}
export function storeMemoryOidcConnection(owner: string, conn: MemoryOidcConnection): string {
  const account = new URL(conn.url).host;
  const blob: OidcBlob = { kind: 'oidc', ...conn };
  const sealed = seal(JSON.stringify(blob), loadKek());
  sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM connection_tokens WHERE owner_id = ? AND provider = ?`).run(owner, MEMORY_PROVIDER);
    sqlite
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), owner, MEMORY_PROVIDER, account, sealed.iv, sealed.authTag, sealed.ciphertext);
  })();
  return account;
}

/** Delete the owner's stored CI-Server connection. Returns rows removed. */
export function deleteMemoryConnection(owner: string): number {
  return sqlite
    .prepare(`DELETE FROM connection_tokens WHERE owner_id = ? AND provider = ?`)
    .run(owner, MEMORY_PROVIDER).changes;
}

/** Auth headers, CI-Import-Tools style: x-api-key and Bearer COEXIST when both are set. */
export function memoryHeaders(creds: MemoryCreds): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (creds.apiKey) h['x-api-key'] = creds.apiKey;
  if (creds.bearer) h['Authorization'] = `Bearer ${creds.bearer}`;
  return h;
}

// ── OIDC refresh (AA0b) ──────────────────────────────────────────────────────────

/**
 * In-process refresh single-flight, keyed by owner: concurrent requests that all see
 * the same expiring token share ONE refresh call, so CI-Portal's token endpoint is hit
 * exactly once (no refresh-token stampede on the stored row). Mirrors BaseOAuth2Client.
 */
const refreshInFlight = new Map<string, Promise<string>>();

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Exchange the refresh token for a fresh access token and re-seal the blob. */
async function refreshOidcBlob(owner: string, blob: OidcBlob): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: blob.refreshToken,
    client_id: blob.clientId,
  });
  if (blob.clientSecret) params.set('client_secret', blob.clientSecret);

  let res: Response;
  try {
    res = await fetch(blob.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
    });
  } catch (err) {
    throw new MemoryUnavailable(`CI-Portal token refresh unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    // A 400/401 here means the refresh token is dead (revoked / expired / rotated away):
    // reconnect via CI-Portal is required. Surface as unavailable so callers degrade.
    throw new MemoryUnavailable(`CI-Portal token refresh failed: HTTP ${res.status} — reconnect Companion Memory`);
  }
  let tok: RefreshResponse;
  try {
    tok = (await res.json()) as RefreshResponse;
  } catch (err) {
    throw new MemoryUnavailable(`CI-Portal token refresh returned unparseable JSON: ${(err as Error).message}`);
  }
  if (!tok.access_token) throw new MemoryUnavailable('CI-Portal token refresh returned no access_token');

  const next: OidcBlob = {
    ...blob,
    accessToken: tok.access_token,
    // Rotation-safe: keep the existing refresh token when the provider omits a new one.
    refreshToken: tok.refresh_token || blob.refreshToken,
    expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
  };
  const sealed = seal(JSON.stringify(next), loadKek());
  sqlite
    .prepare(
      `UPDATE connection_tokens
         SET iv = ?, auth_tag = ?, ciphertext = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       WHERE owner_id = ? AND provider = ? AND status = 'active'`,
    )
    .run(sealed.iv, sealed.authTag, sealed.ciphertext, owner, MEMORY_PROVIDER);
  logger.info('memory OIDC bearer refreshed', { owner });
  return tok.access_token;
}

/**
 * Resolve creds for a LIVE request. For an OIDC connection this refreshes the CI-Server
 * bearer when it's within {@link REFRESH_SKEW_MS} of expiry (single-flighted); manual
 * and env creds pass through {@link memoryCreds} untouched.
 */
export async function resolveLiveMemoryCreds(owner: string): Promise<MemoryCreds | null> {
  let blob: MemoryBlob | null = null;
  try {
    blob = readMemoryBlob(owner);
  } catch (err) {
    logger.warn('resolveLiveMemoryCreds: failed to open ci_memory token', { owner, err: (err as Error).message });
  }
  if (blob?.kind === 'oidc') {
    if (Date.parse(blob.expiresAt) - Date.now() > REFRESH_SKEW_MS) {
      return { url: blob.url, bearer: blob.accessToken };
    }
    let inflight = refreshInFlight.get(owner);
    if (!inflight) {
      inflight = refreshOidcBlob(owner, blob).finally(() => refreshInFlight.delete(owner));
      refreshInFlight.set(owner, inflight);
    }
    const bearer = await inflight;
    return { url: blob.url, bearer };
  }
  // Manual settings row or env fallback — synchronous resolution is authoritative.
  const creds = memoryCreds(owner);
  return creds ? { url: creds.url, apiKey: creds.apiKey, bearer: creds.bearer } : null;
}

// ── live transport ─────────────────────────────────────────────────────────────

async function getJson<T>(owner: string, path: string, params: Record<string, string | undefined>): Promise<T> {
  const creds = await resolveLiveMemoryCreds(owner);
  if (!creds) throw new MemoryUnavailable('No CI-Server credentials configured (connect in Settings or set CI_SERVER_URL)');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, v);
  }
  const url = `${creds.url.replace(/\/+$/, '')}${path}${qs.size ? `?${qs}` : ''}`;
  let res: Response;
  try {
    // redirect: 'manual' — undici drops Authorization on cross-origin redirects but
    // NOT the custom x-api-key header, so following a 3xx could exfiltrate the key.
    res = await fetch(url, { headers: memoryHeaders(creds), redirect: 'manual' });
  } catch (err) {
    throw new MemoryUnavailable(`CI-Server unreachable at ${creds.url}: ${(err as Error).message}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new MemoryUnavailable(`CI-Server GET ${path} responded with a redirect (HTTP ${res.status}); refusing to follow`);
  }
  if (!res.ok) {
    throw new MemoryUnavailable(`CI-Server GET ${path} failed: HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new MemoryUnavailable(`CI-Server GET ${path} returned unparseable JSON: ${(err as Error).message}`);
  }
}

/** Raw node shape on the wire (fixture file uses the same snake_case envelope). */
interface WireNode {
  id?: string;
  entity_id?: string;
  entity_type?: string;
  name?: string;
  description?: string | null;
  properties?: Record<string, unknown>;
}

interface WireLink {
  id?: string;
  relationship_id?: string;
  source?: string;
  target?: string;
  relationship_type?: string;
  strength?: number;
  properties?: Record<string, unknown>;
}

function mapNode(n: WireNode): MemoryNode {
  return {
    id: n.entity_id ?? n.id ?? '',
    entityType: n.entity_type ?? 'unknown',
    name: n.name ?? '',
    description: n.description ?? null,
    properties: n.properties ?? {},
  };
}

function mapLink(l: WireLink): MemoryLink {
  return {
    id: l.relationship_id ?? l.id ?? '',
    source: l.source ?? '',
    target: l.target ?? '',
    relationshipType: l.relationship_type ?? 'related',
    strength: typeof l.strength === 'number' ? l.strength : 0.5,
    properties: l.properties ?? {},
  };
}

// ── fixture transport ──────────────────────────────────────────────────────────

const _dir = dirname(fileURLToPath(import.meta.url));
// server/src/connectors → server/fixtures/memory
const defaultFixturesDir = join(_dir, '..', '..', 'fixtures', 'memory');

function fixturesDir(): string {
  return process.env.CP_MEMORY_FIXTURES_DIR ?? defaultFixturesDir;
}

/**
 * Resolve a fixture-relative timestamp. The checked-in graph.json uses `now±Nh` /
 * `now±Nd` for event times so the fixture always contains UPCOMING events — static
 * ISO dates would silently age out of the agent's next-48h window (the repo's
 * time-bomb-date-test gotcha). Plain ISO strings pass through untouched.
 */
function resolveFixtureDate(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const m = v.match(/^now([+-]\d+)(h|d)$/);
  if (!m) return v;
  const n = Number(m[1]) * (m[2] === 'd' ? 24 : 1);
  return new Date(Date.now() + n * 3_600_000).toISOString();
}

const FIXTURE_DATE_KEYS = ['start_time', 'end_time', 'startTime', 'endTime', 'start', 'end', 'date'];

function loadFixtureGraph(): MemoryGraph {
  const path = join(fixturesDir(), 'graph.json');
  if (!existsSync(path)) {
    logger.warn('memory fixture not found', { path });
    return { nodes: [], links: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { nodes?: WireNode[]; links?: WireLink[] };
    const nodes = (raw.nodes ?? []).map((n) => {
      const node = mapNode(n);
      for (const k of FIXTURE_DATE_KEYS) {
        if (k in node.properties) node.properties[k] = resolveFixtureDate(node.properties[k]);
      }
      return node;
    });
    return { nodes, links: (raw.links ?? []).map(mapLink) };
  } catch (err) {
    logger.error('failed to parse memory fixture', { path, err: (err as Error).message });
    return { nodes: [], links: [] };
  }
}

/** First parseable event-ish timestamp on a node, or null. */
export function nodeStartTime(node: MemoryNode): string | null {
  for (const k of FIXTURE_DATE_KEYS) {
    const v = node.properties[k];
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  }
  return null;
}

/** Apply /graph/data-style filters locally (fixture mode; also a defensive re-filter for live). */
export function filterGraph(graph: MemoryGraph, filters: GraphDataFilters): MemoryGraph {
  const include = filters.includeTypes?.map((t) => t.toLowerCase());
  const nodes = graph.nodes.filter((n) => {
    if (include && !include.includes(n.entityType.toLowerCase())) return false;
    const start = nodeStartTime(n);
    // Undated nodes (people, places) survive a date filter — only dated nodes are windowed.
    if (start) {
      if (filters.from && start < filters.from) return false;
      if (filters.to && start > filters.to) return false;
    }
    return true;
  });
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, links: graph.links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
}

// ── public API ─────────────────────────────────────────────────────────────────

/**
 * LLM-ready context snapshot of the owner's entity universe (GET /graph/context).
 * Fixture mode synthesizes a short summary from the fixture graph.
 */
export async function graphContext(owner: string): Promise<string> {
  if (memoryMode() === 'fixture') {
    const { nodes } = loadFixtureGraph();
    return nodes.map((n) => `${n.entityType}: ${n.name}${n.description ? ` — ${n.description}` : ''}`).join('\n');
  }
  const body = await getJson<{ success?: boolean; context?: unknown }>(owner, '/graph/context', {});
  const ctx = body.context;
  return typeof ctx === 'string' ? ctx : JSON.stringify(ctx ?? '');
}

/** Semantic + structured search (GET /graph/search). Fixture: name/description substring. */
export async function graphSearch(owner: string, query: string, opts: { limit?: number } = {}): Promise<MemoryGraph> {
  if (memoryMode() === 'fixture') {
    const g = loadFixtureGraph();
    const q = query.toLowerCase();
    const nodes = g.nodes
      .filter((n) => n.name.toLowerCase().includes(q) || (n.description ?? '').toLowerCase().includes(q))
      .slice(0, opts.limit ?? 10);
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, links: g.links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
  }
  const body = await getJson<{ nodes?: WireNode[]; links?: WireLink[] }>(owner, '/graph/search', {
    query,
    limit: opts.limit !== undefined ? String(opts.limit) : undefined,
  });
  return { nodes: (body.nodes ?? []).map(mapNode), links: (body.links ?? []).map(mapLink) };
}

/** Nodes + relationships, date-filterable (GET /graph/data). */
export async function graphData(owner: string, filters: GraphDataFilters = {}): Promise<MemoryGraph> {
  if (memoryMode() === 'fixture') {
    return filterGraph(loadFixtureGraph(), filters);
  }
  const body = await getJson<{ data?: { nodes?: WireNode[]; links?: WireLink[] } }>(owner, '/graph/data', {
    from: filters.from,
    to: filters.to,
    includeTypes: filters.includeTypes?.join(','),
  });
  const graph = { nodes: (body.data?.nodes ?? []).map(mapNode), links: (body.data?.links ?? []).map(mapLink) };
  // CI-Server's from/to are event-timeline filters that EXPAND one hop (participants
  // survive); re-filtering locally keeps dated nodes inside the requested window even
  // if the server returned a wider set.
  return filterGraph(graph, { from: filters.from, to: filters.to });
}
