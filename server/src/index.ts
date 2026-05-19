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
import { openDb, setMeta } from './db.js';
import { fullScan, indexFile } from './indexer.js';
import { mountRoutes } from './http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve config relative to the repo root (two levels up from server/src/)
const configPath = join(__dirname, '..', '..', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

const directories = ((config['directories'] as string[] | undefined) ?? []).map(p => resolve(expandPath(p)));
const excludeDirs = new Set<string>((config['excludeDirs'] as string[] | undefined) ?? []);
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
app.get('/v2', (_req, res) => res.redirect('/v2/'));

// SSE client registry
const sseClients = new Set<Response>();
function notifyClients(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(message);
}

mountRoutes(app, {
  db,
  directories,
  excludeDirs,
  config,
  title,
  port,
  sseClients,
  notifyClients,
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
    }
  };
}
watcher.on('change', onFsEvent('change'));
watcher.on('add', onFsEvent('add'));
watcher.on('unlink', onFsEvent('unlink'));

app.listen(port, host, () => {
  console.log(`\n🗒️  Companion Planning running at http://${host}:${port}\n`);
  console.log('Watching directories:');
  directories.forEach(dir => console.log(`  📁 ${dir}`));
  if (host === '0.0.0.0' || host === '::') {
    console.log('\n⚠️  Bound to all interfaces — exposed to your network.');
  }
  console.log('');
});
