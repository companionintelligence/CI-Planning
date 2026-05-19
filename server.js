/**
 * AI-TODO-Static Server
 *
 * Serves markdown files with interactive checkbox support.
 */

import express from 'express';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, dirname, relative, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import chokidar from 'chokidar';

import { expandPath, isPathInRoots, countTodos, applyToggle } from './lib/util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const configPath = join(__dirname, 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const directories = (config.directories || []).map(p => resolve(expandPath(p)));
const excludeDirs = new Set(config.excludeDirs || []);
const port = config.port || 3847;
const title = config.title || 'AI TODO Dashboard';

// Default to loopback. Pass --host 0.0.0.0 (or set HOST env) to expose.
const hostFlagIdx = process.argv.indexOf('--host');
const host =
  hostFlagIdx !== -1 && process.argv[hostFlagIdx + 1]
    ? process.argv[hostFlagIdx + 1]
    : process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const clients = new Set();

// path -> { name, path, relativePath, directory, modified, mtimeMs, todos, content }
const cache = new Map();

function rootForPath(p) {
  return directories.find(d => p === d || p.startsWith(d + sep));
}

function pathIsExcluded(p) {
  return p.split(sep).some(part => excludeDirs.has(part));
}

function buildEntry(path) {
  const root = rootForPath(path);
  if (!root) return null;
  if (pathIsExcluded(path)) return null;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  return {
    name: basename(path),
    path,
    relativePath: relative(root, path),
    directory: basename(root),
    modified: stat.mtime.toISOString(),
    mtimeMs: stat.mtimeMs,
    todos: countTodos(content),
    content,
  };
}

function refresh(path) {
  const e = buildEntry(path);
  if (e) cache.set(path, e);
  else cache.delete(path);
  return e;
}

function publicEntry(entry) {
  const { content, mtimeMs, ...rest } = entry;
  return rest;
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.warn(`Scan ${dir}: ${e.message}`);
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (excludeDirs.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full);
    else if (extname(entry).toLowerCase() === '.md') refresh(full);
  }
}

for (const dir of directories) {
  if (existsSync(dir)) walk(dir);
}
console.log(`Initial scan: ${cache.size} markdown files`);

// API: list files
app.get('/api/files', (req, res) => {
  const files = Array.from(cache.values()).map(publicEntry);
  files.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory.localeCompare(b.directory);
    return a.name.localeCompare(b.name);
  });
  res.json({ files, title });
});

// API: get file content
app.get('/api/file', (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'Path required' });

  const expanded = expandPath(filePath);
  if (!isPathInRoots(expanded, directories)) {
    return res.status(403).json({ error: 'Path not allowed' });
  }

  const safe = resolve(expanded);
  const entry = cache.get(safe) ?? refresh(safe);
  if (!entry) return res.status(404).json({ error: 'File not found' });

  res.json({ content: entry.content, path: safe });
});

// API: toggle checkbox
app.patch('/api/file', (req, res) => {
  const { path: filePath, line, checked, expectedText } = req.body || {};
  if (!filePath || line === undefined) {
    return res.status(400).json({ error: 'Path and line required' });
  }

  const expanded = expandPath(filePath);
  if (!isPathInRoots(expanded, directories)) {
    return res.status(403).json({ error: 'Path not allowed' });
  }
  const safe = resolve(expanded);

  let content;
  try {
    content = readFileSync(safe, 'utf-8');
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }

  const result = applyToggle(content, line, expectedText, !!checked);
  if (result.error) return res.status(409).json({ error: result.error });

  if (!result.noop) {
    try {
      writeFileSync(safe, result.content, 'utf-8');
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  refresh(safe);
  res.json({ success: true, line: result.line, noop: !!result.noop });
});

// API: search
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ results: [] });

  const query = String(q).toLowerCase();
  const results = [];

  for (const entry of cache.values()) {
    const nameMatch = entry.name.toLowerCase().includes(query);
    const matches = [];
    const lines = entry.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query)) {
        matches.push({ line: i + 1, text: lines[i].trim().substring(0, 150) });
        if (matches.length >= 3) break;
      }
    }
    if (nameMatch || matches.length > 0) {
      results.push({ ...publicEntry(entry), nameMatch, matches });
    }
    if (results.length >= 20) break;
  }

  results.sort((a, b) => {
    if (a.nameMatch && !b.nameMatch) return -1;
    if (!a.nameMatch && b.nameMatch) return 1;
    return b.matches.length - a.matches.length;
  });

  res.json({ results, query: q });
});

// API: config
app.get('/api/config', (req, res) => {
  res.json({ directories: config.directories, title });
});

// SSE: live reload
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function notifyClients(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(message);
}

// File watcher — drives cache invalidation and SSE.
const watcher = chokidar.watch(directories, {
  ignored: p => {
    const parts = p.split(sep);
    if (parts.some(part => part.startsWith('.'))) return true;
    if (parts.some(part => excludeDirs.has(part))) return true;
    return false;
  },
  persistent: true,
  ignoreInitial: true,
});

watcher.on('change', path => {
  if (!path.endsWith('.md')) return;
  refresh(path);
  notifyClients('fileChange', { path });
});
watcher.on('add', path => {
  if (!path.endsWith('.md')) return;
  refresh(path);
  notifyClients('fileAdd', { path });
});
watcher.on('unlink', path => {
  if (!path.endsWith('.md')) return;
  cache.delete(path);
  notifyClients('fileRemove', { path });
});

app.listen(port, host, () => {
  console.log(`\n🗒️  AI TODO Dashboard running at http://${host}:${port}\n`);
  console.log('Watching directories:');
  directories.forEach(dir => console.log(`  📁 ${dir}`));
  if (host === '0.0.0.0' || host === '::') {
    console.log('\n⚠️  Bound to all interfaces — exposed to your network.');
  }
  console.log('');
});
