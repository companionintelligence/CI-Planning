/**
 * Companion Planning Server (v2)
 *
 * Markdown = source of truth. SQLite = derived index.
 * HTTP API + SSE live reload; MCP server in lib/mcp.js (separate entrypoint).
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import chokidar from 'chokidar';

import { expandPath, isPathInRoots } from './lib/util.js';
import { openDb, listFiles, queryTodos, searchFts, getTodoByHash, getFileRow, setMeta, getMeta } from './lib/db.js';
import { fullScan, indexFile } from './lib/indexer.js';
import { parseFile, toggleTodoByHash, appendUnderHeading, hashTodo, sha256 } from './lib/markdown.js';
import { ollamaAvailable, triageTodos, summarizeDay, listModels, LLMUnavailable } from './lib/llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const configPath = join(__dirname, 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const directories = (config.directories || []).map(p => resolve(expandPath(p)));
const excludeDirs = new Set(config.excludeDirs || []);
const port = config.port || 3847;
const title = config.title || 'Companion Planning';

const hostFlagIdx = process.argv.indexOf('--host');
const host =
  hostFlagIdx !== -1 && process.argv[hostFlagIdx + 1]
    ? process.argv[hostFlagIdx + 1]
    : process.env.HOST || '127.0.0.1';

const db = openDb();
console.log('Database opened.');

console.log('Initial scan starting…');
const t0 = Date.now();
const scanStats = fullScan(db, directories, excludeDirs);
console.log(`Initial scan: ${scanStats.files} files, ${scanStats.todos} todos, ${scanStats.skipped} skipped (cache hit) in ${Date.now() - t0}ms`);
setMeta(db, 'last_full_scan_ms', String(Date.now()));

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(join(__dirname, 'public')));

const clients = new Set();
function notifyClients(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(message);
}

function expandAndCheck(filePath) {
  const safe = resolve(expandPath(filePath));
  if (!isPathInRoots(safe, directories)) {
    const err = new Error('Path not allowed');
    err.code = 403;
    throw err;
  }
  return safe;
}

function rootForPath(p) {
  return directories.find(d => p === d || p.startsWith(d + sep));
}

function atomicWrite(targetPath, content) {
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, targetPath);
}

// ---------------- HTTP API ----------------

app.get('/api/config', (req, res) => {
  res.json({ directories: config.directories, title, port });
});

app.get('/api/files', (req, res) => {
  const files = listFiles(db).map(f => ({
    ...f,
    todos: { unchecked: f.open, checked: f.done, total: f.open + f.done },
  }));
  res.json({ files, title });
});

app.get('/api/file', (req, res) => {
  try {
    const safe = expandAndCheck(req.query.path);
    if (!existsSync(safe)) return res.status(404).json({ error: 'not found' });
    const content = readFileSync(safe, 'utf-8');
    const parsed = parseFile(safe, content);
    res.json({
      content,
      path: safe,
      sha256: parsed.contentSha,
      todos: parsed.todos.map(t => ({ ...t })),
      headings: parsed.headings,
      frontmatter: parsed.frontmatter,
    });
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

// Toggle a checkbox by stable hash. Falls back to line+expectedText if hash absent.
app.patch('/api/file', (req, res) => {
  try {
    const { path: filePath, hash, checked } = req.body || {};
    if (!filePath || typeof checked !== 'boolean') {
      return res.status(400).json({ error: 'path and checked required' });
    }
    const safe = expandAndCheck(filePath);
    if (!hash) return res.status(400).json({ error: 'hash required (use stable todo hash, not line)' });

    const content = readFileSync(safe, 'utf-8');
    const result = toggleTodoByHash(content, hash, safe, checked);
    if (result.error) return res.status(404).json({ error: result.error });
    if (!result.noop) {
      atomicWrite(safe, result.content);
      const root = rootForPath(safe);
      indexFile(db, safe, root);
      notifyClients('fileChange', { path: safe });
    }
    res.json({ success: true, noop: !!result.noop, hash, sha256: sha256(result.content) });
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

// Full-content replace with optimistic concurrency
app.put('/api/file', (req, res) => {
  try {
    const { path: filePath, content, expected_sha256 } = req.body || {};
    if (!filePath || typeof content !== 'string') return res.status(400).json({ error: 'path and content required' });
    const safe = expandAndCheck(filePath);
    if (existsSync(safe)) {
      const curr = readFileSync(safe, 'utf-8');
      const cs = sha256(curr);
      if (expected_sha256 && cs !== expected_sha256) {
        return res.status(409).json({ error: 'sha256 mismatch', current_sha256: cs });
      }
    }
    atomicWrite(safe, content);
    const root = rootForPath(safe);
    indexFile(db, safe, root);
    notifyClients('fileChange', { path: safe });
    res.json({ success: true, sha256: sha256(content) });
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

// Add a todo under a heading
app.post('/api/todo', (req, res) => {
  try {
    const { path: filePath, heading, text, due, tags } = req.body || {};
    if (!filePath || !text) return res.status(400).json({ error: 'path and text required' });
    const safe = expandAndCheck(filePath);
    const content = existsSync(safe) ? readFileSync(safe, 'utf-8') : '';
    let line = `- [ ] ${text}`;
    if (Array.isArray(tags) && tags.length) line += ' ' + tags.map(t => `#${t}`).join(' ');
    if (due) line += ` (due: ${due})`;
    const updated = appendUnderHeading(content, heading || 'Inbox', line);
    atomicWrite(safe, updated);
    const root = rootForPath(safe);
    indexFile(db, safe, root);
    notifyClients('fileChange', { path: safe });
    res.json({ success: true, hash: hashTodo(safe, heading || 'Inbox', line.replace(/^- \[ \] /, '')) });
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

app.get('/api/todos', (req, res) => {
  const filter = {
    checked: req.query.done === 'true' ? 1 : req.query.open === 'true' ? 0 : undefined,
    due: req.query.due,
    tag: req.query.tag,
    file: req.query.file,
    q: req.query.q,
    limit: req.query.limit,
  };
  const todos = queryTodos(db, filter).map(rowToTodo);
  res.json({ todos, count: todos.length });
});

function rowToTodo(r) {
  return {
    hash: r.hash,
    file_path: r.file_path,
    line: r.line,
    indent: r.indent,
    text: r.text,
    plain_text: r.plain_text,
    checked: !!r.checked,
    heading: r.heading,
    heading_path: r.heading_path,
    tags: r.tags_json ? JSON.parse(r.tags_json) : [],
    due_date: r.due_date,
    done_date: r.done_date,
    priority: r.priority,
  };
}

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ results: [], query: q });
  let results = [];
  try {
    results = searchFts(db, q, Math.min(Number(req.query.limit) || 50, 200)).map(r => ({
      path: r.path,
      heading: r.heading,
      snippet: r.snippet,
      score: r.score,
    }));
  } catch (e) {
    // FTS syntax errors fall back to LIKE search
    const like = `%${q}%`;
    results = db
      .prepare(
        `SELECT path, '' AS heading, substr(body, 1, 200) AS snippet, 0 AS score
         FROM notes_fts WHERE body LIKE ? OR heading LIKE ? LIMIT 50`
      )
      .all(like, like);
  }
  res.json({ results, query: q });
});

// Force a full rebuild of the index. Useful after editing config.excludeDirs
// or when the file watcher missed something. The watcher handles ordinary edits.
app.post('/api/rescan', (req, res) => {
  const t0 = Date.now();
  try {
    const stats = fullScan(db, directories, [...excludeDirs]);
    res.json({ ok: true, ms: Date.now() - t0, ...stats });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/stats', (req, res) => {
  const stats = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM files) AS files,
        (SELECT COUNT(*) FROM todos) AS todos_total,
        (SELECT COUNT(*) FROM todos WHERE checked=0) AS todos_open,
        (SELECT COUNT(*) FROM todos WHERE checked=1) AS todos_done,
        (SELECT COUNT(*) FROM todos WHERE checked=0 AND due_date IS NOT NULL AND due_date < date('now','localtime')) AS overdue,
        (SELECT COUNT(*) FROM todos WHERE checked=0 AND due_date = date('now','localtime')) AS due_today`
    )
    .get();
  res.json(stats);
});

app.post('/api/llm/triage', async (req, res) => {
  try {
    const filter = {
      checked: 0,
      file: req.body?.path,
      tag: req.body?.tag,
      limit: Math.min(Number(req.body?.limit) || 50, 150),
    };
    const todos = queryTodos(db, filter).map(rowToTodo);
    if (!todos.length) return res.json({ actions: [], todos: 0 });
    const result = await triageTodos(todos.map(t => ({
      hash: t.hash,
      relativePath: t.file_path,
      heading: t.heading,
      plainText: t.plain_text,
    })));
    res.json({ ...result, todos: todos.length });
  } catch (e) {
    if (e instanceof LLMUnavailable) return res.status(503).json({ error: 'ollama not reachable' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/llm/summary', async (req, res) => {
  try {
    const todos = queryTodos(db, { checked: 0, limit: 200 }).map(rowToTodo);
    const result = await summarizeDay(todos);
    res.json(result);
  } catch (e) {
    if (e instanceof LLMUnavailable) return res.status(503).json({ error: 'ollama not reachable' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/llm/status', async (req, res) => {
  const up = await ollamaAvailable();
  if (!up) return res.json({ available: false });
  try {
    const models = await listModels();
    res.json({ available: true, models });
  } catch {
    res.json({ available: false });
  }
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write('retry: 5000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ---------------- Watcher ----------------
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

function onFsEvent(eventName) {
  return (path) => {
    if (!path.endsWith('.md')) return;
    const root = rootForPath(path);
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
