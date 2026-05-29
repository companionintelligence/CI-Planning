/**
 * Companion Planning Server v3 — TypeScript entrypoint.
 *
 * Markdown = source of truth. SQLite = derived index.
 * HTTP API + SSE live reload; MCP server in mcp.ts (separate stdio entrypoint).
 */
import express, { type Response } from 'express';
import { readFileSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import chokidar from 'chokidar';

import { expandPath } from './util.js';
import { openDb, setMeta, insertSuggestion } from './db.js';
import { fullScan, indexFile } from './indexer.js';
import { mountRoutes } from './http.js';
import { CalendarBridge } from './calendar.js';
import { extractTodosFromText, LLMUnavailable, setPreferredModel } from './llm.js';
import { buildMcpServer } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve config: COMPANION_CONFIG env var overrides the default location
const configPath = process.env['COMPANION_CONFIG'] ?? join(__dirname, '..', '..', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

const directories = ((config['directories'] as string[] | undefined) ?? []).map(p => resolve(expandPath(p)));
const excludeDirs = new Set<string>((config['excludeDirs'] as string[] | undefined) ?? []);

// Optional pinned LLM model from config.json: { "llm": { "model": "qwen2.5:0.5b" } }
const llmCfg = config['llm'] as { model?: string } | undefined;
if (llmCfg?.model) setPreferredModel(llmCfg.model);
const port = Number(config['port']) || 3847;
const title = (config['title'] as string | undefined) ?? 'Companion Planning';

const hostFlagIdx = process.argv.indexOf('--host');
const host =
  hostFlagIdx !== -1 && process.argv[hostFlagIdx + 1]
    ? process.argv[hostFlagIdx + 1]!
    : process.env['HOST'] ?? '127.0.0.1';

const db = openDb();
console.log('Database opened.');

console.log('Initial scan starting…');
const t0 = Date.now();
const scanStats = fullScan(db, directories, excludeDirs);
console.log(`Initial scan: ${scanStats.files} files, ${scanStats.todos} todos, ${scanStats.skipped} skipped in ${Date.now() - t0}ms`);
setMeta(db, 'last_full_scan_ms', String(Date.now()));

const app = express();
app.use(express.json({ limit: '4mb' }));

// Serve static assets: built UI from public/ (V1 PWA + V2 Svelte build at /v2/)
const publicDir = join(__dirname, '..', '..', 'public');
app.use(express.static(publicDir));

// SSE client registry
const sseClients = new Set<Response>();
function notifyClients(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(message);
}

const calendar = new CalendarBridge(db);

mountRoutes(app, {
  db,
  directories,
  excludeDirs,
  config,
  title,
  port,
  sseClients,
  notifyClients,
  calendar,
});

// ---------------- Watcher ----------------
const watcher = chokidar.watch(directories, {
  ignored: (p: string) => {
    const parts = p.split(sep);
    if (parts.some(part => part.startsWith('.'))) return true;
    if (parts.some(part => excludeDirs.has(part))) return true;
    return false;
  },
  persistent: true,
  ignoreInitial: true,
});

// V4: optional auto-extract on file change
const autoExtractCfg = (config['autoExtract'] as { enabled?: boolean; throttleMs?: number } | undefined) ?? {};
const autoExtractEnabled = autoExtractCfg.enabled === true;
const autoExtractThrottle = autoExtractCfg.throttleMs ?? 30_000;
const extractTimers = new Map<string, NodeJS.Timeout>();

async function maybeAutoExtract(path: string): Promise<void> {
  if (!autoExtractEnabled) return;
  // Skip very large files (>200KB) — too noisy
  try {
    const { readFileSync } = await import('fs');
    const content = readFileSync(path, 'utf-8');
    if (content.length > 200_000) return;
    const extracted = await extractTodosFromText(content.slice(0, 8000));
    for (const t of extracted.todos ?? []) {
      insertSuggestion(db, {
        file_path: path,
        heading: t.heading ?? null,
        text: t.text,
        kind: 'suggested',
        source_quote: null,
        confidence: 0.7,
        maybe_done_for_hash: null,
        duplicate_of_hash: null,
      });
    }
    if ((extracted.todos ?? []).length > 0) notifyClients('suggestionsUpdated', { path, count: extracted.todos.length });
  } catch (e) {
    if (!(e instanceof LLMUnavailable)) {
      console.warn(`auto-extract failed for ${path}:`, (e as Error).message);
    }
  }
}

function scheduleExtract(path: string): void {
  if (!autoExtractEnabled) return;
  const existing = extractTimers.get(path);
  if (existing) clearTimeout(existing);
  extractTimers.set(path, setTimeout(() => {
    extractTimers.delete(path);
    void maybeAutoExtract(path);
  }, autoExtractThrottle));
}

function onFsEvent(eventName: string) {
  return (path: string) => {
    if (!path.endsWith('.md')) return;
    const root = directories.find(d => path === d || path.startsWith(d + sep));
    if (!root) return;
    if (eventName === 'unlink') {
      db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
      db.prepare(`DELETE FROM notes_fts WHERE path = ?`).run(path);
      notifyClients('fileRemove', { path });
    } else {
      indexFile(db, path, root);
      notifyClients(eventName === 'add' ? 'fileAdd' : 'fileChange', { path });
      scheduleExtract(path);
    }
  };
}
watcher.on('change', onFsEvent('change'));
watcher.on('add', onFsEvent('add'));
watcher.on('unlink', onFsEvent('unlink'));

// ============== MCP over HTTP (StreamableHTTPServerTransport) ==============
// Lets remote agents attach via `http://host:port/mcp` without SSH/stdio.
// Uses stateful sessions (one MCP server per connection) so each agent gets
// isolated tool call state.
const mcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ReturnType<typeof buildMcpServer> }>();

async function handleMcp(req: import('express').Request, res: import('express').Response): Promise<void> {
  const sessionIdHeader = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
  let entry = sessionId ? mcpSessions.get(sessionId) : undefined;
  if (!entry) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcpServer = buildMcpServer({ db, directories, excludeDirs, calendar });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mcpServer.connect(transport as any);
    transport.onclose = () => {
      if (transport.sessionId) mcpSessions.delete(transport.sessionId);
    };
    entry = { transport, server: mcpServer };
    if (transport.sessionId) mcpSessions.set(transport.sessionId, entry);
  }
  await entry.transport.handleRequest(req, res, req.body);
}

app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);

app.listen(port, host, () => {
  console.log(`\n🗒️  Companion Planning running at http://${host}:${port}\n`);
  console.log('Watching directories:');
  directories.forEach(dir => console.log(`  📁 ${dir}`));
  if (host === '0.0.0.0' || host === '::') {
    console.log('\n⚠️  Bound to all interfaces — exposed to your network.');
  }
  console.log('');
});
