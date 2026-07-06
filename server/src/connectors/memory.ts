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
export function memoryCreds(owner: string): (MemoryCreds & { source: MemoryCredsSource }) | null {
  try {
    const row = sqlite
      .prepare(
        `SELECT iv, auth_tag, ciphertext FROM connection_tokens
          WHERE owner_id = ? AND provider = ? AND status = 'active'`,
      )
      .get(owner, MEMORY_PROVIDER) as { iv: string; auth_tag: string; ciphertext: string } | undefined;
    if (row) {
      const parsed = JSON.parse(open({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, loadKek())) as MemoryCreds;
      if (parsed.url) {
        return { url: parsed.url, apiKey: parsed.apiKey, bearer: parsed.bearer, source: 'settings' };
      }
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
    return { url, apiKey: process.env.CI_SERVER_API_KEY || undefined, source: 'env' };
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

// ── live transport ─────────────────────────────────────────────────────────────

async function getJson<T>(owner: string, path: string, params: Record<string, string | undefined>): Promise<T> {
  const creds = memoryCreds(owner);
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
