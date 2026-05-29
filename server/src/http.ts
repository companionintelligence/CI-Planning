/**
 * Express HTTP API routes for Companion Planning.
 * Keeps route handlers separate from the server entrypoint.
 */
import express, { type Request, type Response, type Application } from 'express';
import { readFileSync, existsSync } from 'fs';
import { resolve, sep } from 'path';
import type Database from 'better-sqlite3';
import { expandPath, isPathInRoots, atomicWrite } from './util.js';
import {
  listFiles,
  queryTodos,
  searchFts,
  getTodoByHash,
  getStats,
  setMeta,
  logTaskEvent,
  getTaskEvents,
  dailyCapacity,
  memorySet,
  memoryGet,
  memoryList,
  insertSuggestion,
  listSuggestions,
  updateSuggestionStatus,
  getSuggestion,
  listCalendarLinksInRange,
} from './db.js';
import { indexFile, fullScan, type ScanStats } from './indexer.js';
import {
  parseFile,
  toggleTodoByHash,
  appendUnderHeading,
  hashTodo,
  sha256,
} from './markdown.js';
import {
  ollamaAvailable,
  triageTodos,
  summarizeDay,
  listModels,
  extractTodosFromText,
  projectRollup,
  proposeArchive,
  LLMUnavailable,
} from './llm.js';
import { rewriteTodoByHash } from './markdown.js';
import type { TodoRowDb, TodoFilter } from './types.js';
import type { CalendarBridge } from './calendar.js';

export interface HttpServerDeps {
  db: Database.Database;
  directories: string[];
  excludeDirs: Set<string>;
  config: Record<string, unknown>;
  title: string;
  port: number;
  sseClients: Set<Response>;
  notifyClients: (event: string, data: unknown) => void;
  calendar?: CalendarBridge;
}

function expandAndCheck(filePath: string, directories: string[]): string {
  const safe = resolve(expandPath(filePath));
  if (!isPathInRoots(safe, directories)) {
    const err = Object.assign(new Error('Path not allowed'), { code: 403 });
    throw err;
  }
  return safe;
}

function rootForPath(p: string, directories: string[]): string | undefined {
  return directories.find(d => p === d || p.startsWith(d + sep));
}

function rowToTodo(r: TodoRowDb) {
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
    tags: r.tags_json ? JSON.parse(r.tags_json) as string[] : [],
    due_date: r.due_date,
    done_date: r.done_date,
    priority: r.priority,
  };
}

export function mountRoutes(app: Application, deps: HttpServerDeps): void {
  const { db, directories, excludeDirs, config, title, port, sseClients, notifyClients, calendar } = deps;

  const check = (p: string) => expandAndCheck(p, directories);
  const rootFor = (p: string) => rootForPath(p, directories);

  app.get('/api/health', (_req: Request, res: Response) => {
    const stats = getStats(db);
    res.json({
      ok: true,
      version: '3.0.0',
      uptime_s: Math.floor(process.uptime()),
      files: stats.files,
      todos_total: stats.todos_total,
    });
  });

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({ directories: config['directories'], title, port });
  });

  app.get('/api/files', (_req: Request, res: Response) => {
    const files = listFiles(db).map(f => ({
      ...f,
      todos: { unchecked: f.open ?? 0, checked: f.done ?? 0, total: (f.open ?? 0) + (f.done ?? 0) },
    }));
    res.json({ files, title });
  });

  app.get('/api/file', (req: Request, res: Response) => {
    try {
      const safe = check(req.query['path'] as string);
      if (!existsSync(safe)) return void res.status(404).json({ error: 'not found' });
      const content = readFileSync(safe, 'utf-8');
      const parsed = parseFile(safe, content);
      res.json({ content, path: safe, sha256: parsed.contentSha, todos: parsed.todos, headings: parsed.headings, frontmatter: parsed.frontmatter });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      res.status(err.code ?? 500).json({ error: err.message });
    }
  });

  app.patch('/api/file', (req: Request, res: Response) => {
    try {
      const { path: filePath, hash, checked } = req.body as { path?: string; hash?: string; checked?: boolean };
      if (!filePath || typeof checked !== 'boolean') {
        return void res.status(400).json({ error: 'path and checked required' });
      }
      if (!hash) return void res.status(400).json({ error: 'hash required' });
      const safe = check(filePath);
      const content = readFileSync(safe, 'utf-8');
      const result = toggleTodoByHash(content, hash, safe, checked);
      if ('error' in result) return void res.status(404).json({ error: result.error });
      if (!result.noop) {
        atomicWrite(safe, result.content);
        const root = rootFor(safe);
        if (root) indexFile(db, safe, root);
        notifyClients('fileChange', { path: safe });
      }
      res.json({ success: true, noop: !!result.noop, hash, sha256: sha256(result.content) });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      res.status(err.code ?? 500).json({ error: err.message });
    }
  });

  app.put('/api/file', (req: Request, res: Response) => {
    try {
      const { path: filePath, content, expected_sha256 } = req.body as {
        path?: string; content?: string; expected_sha256?: string;
      };
      if (!filePath || typeof content !== 'string') {
        return void res.status(400).json({ error: 'path and content required' });
      }
      const safe = check(filePath);
      if (existsSync(safe)) {
        const curr = readFileSync(safe, 'utf-8');
        const cs = sha256(curr);
        if (expected_sha256 && cs !== expected_sha256) {
          return void res.status(409).json({ error: 'sha256 mismatch', current_sha256: cs });
        }
      }
      atomicWrite(safe, content);
      const root = rootFor(safe);
      if (root) indexFile(db, safe, root);
      notifyClients('fileChange', { path: safe });
      res.json({ success: true, sha256: sha256(content) });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      res.status(err.code ?? 500).json({ error: err.message });
    }
  });

  app.post('/api/todo', (req: Request, res: Response) => {
    try {
      const { path: filePath, heading, text, due, tags } = req.body as {
        path?: string; heading?: string; text?: string; due?: string; tags?: string[];
      };
      if (!filePath || !text) return void res.status(400).json({ error: 'path and text required' });
      const safe = check(filePath);
      const content = existsSync(safe) ? readFileSync(safe, 'utf-8') : '';
      let line = `- [ ] ${text}`;
      if (Array.isArray(tags) && tags.length) line += ' ' + tags.map(t => `#${t}`).join(' ');
      if (due) line += ` (due: ${due})`;
      const updated = appendUnderHeading(content, heading ?? 'Inbox', line);
      atomicWrite(safe, updated);
      const root = rootFor(safe);
      if (root) indexFile(db, safe, root);
      notifyClients('fileChange', { path: safe });
      res.json({ success: true, hash: hashTodo(safe, heading ?? 'Inbox', line.replace(/^- \[ \] /, '')) });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      res.status(err.code ?? 500).json({ error: err.message });
    }
  });

  app.get('/api/todos', (req: Request, res: Response) => {
    const filter: TodoFilter = {};
    if (req.query['done'] === 'true') filter.checked = 1;
    else if (req.query['open'] === 'true') filter.checked = 0;
    const due = req.query['due'] as string | undefined;
    if (due === 'today' || due === 'overdue' || due === 'this_week') filter.due = due;
    if (req.query['tag']) filter.tag = req.query['tag'] as string;
    if (req.query['file']) filter.file = req.query['file'] as string;
    if (req.query['q']) filter.q = req.query['q'] as string;
    if (req.query['limit']) filter.limit = Number(req.query['limit']);
    const todos = queryTodos(db, filter).map(rowToTodo);
    res.json({ todos, count: todos.length });
  });

  app.get('/api/search', (req: Request, res: Response) => {
    const q = ((req.query['q'] as string) ?? '').trim();
    if (q.length < 2) return void res.json({ results: [], query: q });
    let results: unknown[];
    try {
      results = searchFts(db, q, Math.min(Number(req.query['limit']) || 50, 200)).map(r => ({
        path: r.path,
        heading: r.heading,
        snippet: r.snippet,
        score: r.score,
      }));
    } catch {
      const like = `%${q}%`;
      results = (
        db
          .prepare(
            `SELECT path, '' AS heading, substr(body, 1, 200) AS snippet, 0 AS score
             FROM notes_fts WHERE body LIKE ? OR heading LIKE ? LIMIT 50`,
          )
          .all(like, like)
      );
    }
    res.json({ results, query: q });
  });

  app.post('/api/rescan', (_req: Request, res: Response) => {
    const t0 = Date.now();
    try {
      const stats = fullScan(db, directories, excludeDirs);
      res.json({ ok: true, ms: Date.now() - t0, ...stats });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/stats', (_req: Request, res: Response) => {
    res.json(getStats(db));
  });

  app.post('/api/llm/triage', async (req: Request, res: Response) => {
    try {
      const body = req.body as { path?: string; tag?: string; limit?: number };
      const filter: TodoFilter = { checked: 0, limit: Math.min(Number(body.limit) || 50, 150) };
      if (body.path) filter.file = body.path;
      if (body.tag) filter.tag = body.tag;
      const todos = queryTodos(db, filter).map(rowToTodo);
      if (!todos.length) return void res.json({ actions: [], todos: 0 });
      const result = await triageTodos(todos.map(t => ({
        hash: t.hash,
        relativePath: t.file_path,
        heading: t.heading ?? null,
        plainText: t.plain_text,
      })));
      res.json({ ...result, todos: todos.length });
    } catch (e) {
      if (e instanceof LLMUnavailable) return void res.status(503).json({ error: 'ollama not reachable' });
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/llm/summary', async (_req: Request, res: Response) => {
    try {
      const todos = queryTodos(db, { checked: 0, limit: 200 });
      const result = await summarizeDay(todos);
      res.json(result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return void res.status(503).json({ error: 'ollama not reachable' });
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/llm/extract', async (req: Request, res: Response) => {
    try {
      const body = req.body as { text?: string };
      if (!body.text) return void res.status(400).json({ error: 'text required' });
      const result = await extractTodosFromText(body.text);
      res.json(result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return void res.status(503).json({ error: 'ollama not reachable' });
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/llm/rollup', async (req: Request, res: Response) => {
    try {
      const body = req.body as { path?: string; limit?: number };
      const filter: TodoFilter = { limit: Math.min(Number(body.limit) || 200, 500) };
      if (body.path) filter.file = check(body.path);
      const todos = queryTodos(db, filter);
      const fileTitle = body.path ? body.path.split('/').slice(-1)[0] : undefined;
      const rollupOpts: { title?: string } = {}; if (fileTitle) rollupOpts.title = fileTitle; const result = await projectRollup(todos, rollupOpts);
      res.json(result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return void res.status(503).json({ error: 'ollama not reachable' });
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/llm/archive', async (req: Request, res: Response) => {
    try {
      const body = req.body as { path?: string; limit?: number };
      const filter: TodoFilter = { checked: 0, limit: Math.min(Number(body.limit) || 80, 150) };
      if (body.path) filter.file = check(body.path);
      const todos = queryTodos(db, filter).map(rowToTodo);
      const result = await proposeArchive(todos.map(t => ({
        hash: t.hash,
        relativePath: t.file_path,
        heading: t.heading ?? null,
        plainText: t.plain_text,
      })));
      res.json(result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return void res.status(503).json({ error: 'ollama not reachable' });
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // apply_suggestion: the ONLY write path for LLM-proposed mutations
  app.post('/api/suggestion/apply', (req: Request, res: Response) => {
    try {
      const { hash, action, new_text, due, tag } = req.body as {
        hash?: string;
        action?: string;
        new_text?: string;
        due?: string;
        tag?: string;
      };
      if (!hash || !action) return void res.status(400).json({ error: 'hash and action required' });
      const row = getTodoByHash(db, hash);
      if (!row) return void res.status(404).json({ error: `No todo with hash ${hash}` });
      const safe = row.file_path;
      const content = readFileSync(safe, 'utf-8');
      let result;
      if (action === 'archive' || action === 'mark_done') {
        result = toggleTodoByHash(content, hash, safe, true);
      } else if (action === 'rewrite' && new_text) {
        result = rewriteTodoByHash(content, hash, safe, new_text);
      } else if (action === 'add_tag' && tag) {
        const row2 = queryTodos(db, { q: hash, limit: 1 });
        const oldText = row.text;
        result = rewriteTodoByHash(content, hash, safe, `${oldText} #${tag}`);
      } else if (action === 'set_due' && due) {
        const clean = row.text.replace(/\s*\(due:\s*\d{4}-\d{2}-\d{2}\)/i, '').trim();
        result = rewriteTodoByHash(content, hash, safe, `${clean} (due: ${due})`);
      } else {
        return void res.status(400).json({ error: `Unknown action: ${action}` });
      }
      if ('error' in result) return void res.status(422).json({ error: result.error });
      if (!result.noop) {
        atomicWrite(safe, result.content);
        const root = rootFor(safe);
        if (root) indexFile(db, safe, root);
        notifyClients('fileChange', { path: safe });
      }
      res.json({ ok: true, noop: !!result.noop, hash, sha256: sha256(result.content) });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      res.status(err.code ?? 500).json({ error: err.message });
    }
  });

  app.get('/api/llm/status', async (_req: Request, res: Response) => {
    const up = await ollamaAvailable();
    if (!up) return void res.json({ available: false });
    try {
      const models = await listModels();
      res.json({ available: true, models });
    } catch {
      res.json({ available: false });
    }
  });

  app.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write('retry: 5000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ============== V4 ROUTES ==============

  // ---- Lookahead: day-by-day capacity for next N weeks ----
  app.get('/api/lookahead', (req: Request, res: Response) => {
    const weeks = Math.min(Math.max(Number(req.query['weeks']) || 3, 1), 12);
    const workdayMinutes = Number(req.query['workday_minutes']) || 480;
    const now = Date.now();
    const startD = new Date(now).toISOString().slice(0, 10);
    const endD = new Date(now + weeks * 7 * 86400000).toISOString().slice(0, 10);
    const days = dailyCapacity(db, startD, endD, workdayMinutes).map(d => ({
      ...d,
      capacity_pct: Math.round((d.committed_minutes / workdayMinutes) * 100),
      over_capacity: d.committed_minutes > workdayMinutes,
      workday_minutes: workdayMinutes,
    }));
    res.json({ days, weeks, workday_minutes: workdayMinutes });
  });

  // ---- Capacity report: day-by-day for an explicit date range ----
  app.get('/api/capacity', (req: Request, res: Response) => {
    const startDate = req.query['start_date'] as string;
    const endDate = req.query['end_date'] as string;
    const workdayMinutes = Number(req.query['workday_minutes']) || 480;
    if (!startDate || !endDate) return void res.status(400).json({ error: 'start_date and end_date required (YYYY-MM-DD)' });
    const days = dailyCapacity(db, startDate, endDate, workdayMinutes).map(d => ({
      ...d,
      capacity_pct: Math.round((d.committed_minutes / workdayMinutes) * 100),
      over_capacity: d.committed_minutes > workdayMinutes,
    }));
    res.json({ days, workday_minutes: workdayMinutes });
  });

  // ---- Task history ----
  app.get('/api/task/:hash/history', (req: Request, res: Response) => {
    const hash = String(req.params['hash'] ?? '');
    if (!hash) return void res.status(400).json({ error: 'hash required' });
    const events = getTaskEvents(db, hash, 200);
    res.json({ events, hash });
  });

  // ---- Set estimate ----
  app.post('/api/task/estimate', (req: Request, res: Response) => {
    const { hash, minutes } = req.body as { hash?: string; minutes?: number };
    if (!hash || typeof minutes !== 'number' || minutes <= 0) {
      return void res.status(400).json({ error: 'hash and positive minutes required' });
    }
    const row = getTodoByHash(db, hash);
    if (!row) return void res.status(404).json({ error: `No todo with hash ${hash}` });
    db.prepare(`UPDATE todos SET estimated_minutes=? WHERE hash=?`).run(minutes, hash);
    logTaskEvent(db, hash, 'estimated', 'user', { minutes });
    res.json({ ok: true, minutes });
  });

  // ---- Calendar links ----
  app.get('/api/calendar', (req: Request, res: Response) => {
    const startDate = req.query['start_date'] as string;
    const endDate = req.query['end_date'] as string;
    if (!startDate || !endDate) return void res.status(400).json({ error: 'start_date and end_date required (YYYY-MM-DD)' });
    const startMs = new Date(startDate + 'T00:00:00').getTime();
    const endMs = new Date(endDate + 'T23:59:59').getTime();
    const links = listCalendarLinksInRange(db, startMs, endMs);
    res.json({ links });
  });

  // ---- Review queue: list ----
  app.get('/api/suggestions', (req: Request, res: Response) => {
    const status = (req.query['status'] as string) || 'pending';
    if (status !== 'pending' && status !== 'accepted' && status !== 'dismissed') {
      return void res.status(400).json({ error: 'status must be pending|accepted|dismissed' });
    }
    const items = listSuggestions(db, status);
    res.json({ items, count: items.length });
  });

  // ---- Review queue: accept ----
  app.post('/api/suggestion/:id/accept', (req: Request, res: Response) => {
    const id = Number(req.params['id']);
    if (!id) return void res.status(400).json({ error: 'id required' });
    const s = getSuggestion(db, id);
    if (!s) return void res.status(404).json({ error: `No suggestion ${id}` });
    if (s.status !== 'pending') return void res.status(409).json({ error: `Already ${s.status}` });

    try {
      if (s.kind === 'suggested') {
        const content = existsSync(s.file_path) ? readFileSync(s.file_path, 'utf-8') : '';
        const heading = s.heading ?? 'Inbox';
        const line = `- [ ] ${s.text}`;
        const updated = appendUnderHeading(content, heading, line);
        atomicWrite(s.file_path, updated);
        const root = rootFor(s.file_path);
        if (root) indexFile(db, s.file_path, root);
        const hash = hashTodo(s.file_path, heading, s.text);
        logTaskEvent(db, hash, 'created', 'agent:accept_suggestion', { suggestion_id: id });
        updateSuggestionStatus(db, id, 'accepted');
        notifyClients('fileChange', { path: s.file_path });
        return void res.json({ ok: true, hash });
      }
      if (s.kind === 'maybe_done' && s.maybe_done_for_hash) {
        const row = getTodoByHash(db, s.maybe_done_for_hash);
        if (!row) return void res.status(404).json({ error: 'Target todo not found' });
        const content = readFileSync(row.file_path, 'utf-8');
        const result = toggleTodoByHash(content, s.maybe_done_for_hash, row.file_path, true);
        if ('error' in result) return void res.status(422).json({ error: result.error });
        if (!result.noop) {
          atomicWrite(row.file_path, result.content);
          const root = rootFor(row.file_path);
          if (root) indexFile(db, row.file_path, root);
          notifyClients('fileChange', { path: row.file_path });
        }
        logTaskEvent(db, s.maybe_done_for_hash, 'completed', 'agent:accept_suggestion', { suggestion_id: id });
        updateSuggestionStatus(db, id, 'accepted');
        return void res.json({ ok: true, hash: s.maybe_done_for_hash });
      }
      if (s.kind === 'duplicate') {
        updateSuggestionStatus(db, id, 'accepted');
        return void res.json({ ok: true });
      }
      return void res.status(400).json({ error: `Unknown kind ${s.kind}` });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ---- Review queue: dismiss ----
  app.post('/api/suggestion/:id/dismiss', (req: Request, res: Response) => {
    const id = Number(req.params['id']);
    if (!id) return void res.status(400).json({ error: 'id required' });
    const s = getSuggestion(db, id);
    if (!s) return void res.status(404).json({ error: `No suggestion ${id}` });
    updateSuggestionStatus(db, id, 'dismissed');
    res.json({ ok: true });
  });

  // ---- Extract from a source file (manual trigger) ----
  app.post('/api/extract', async (req: Request, res: Response) => {
    try {
      const { path: filePath } = req.body as { path?: string };
      if (!filePath) return void res.status(400).json({ error: 'path required' });
      const safe = check(filePath);
      if (!existsSync(safe)) return void res.status(404).json({ error: 'not found' });
      const content = readFileSync(safe, 'utf-8');
      const extracted = await extractTodosFromText(content.slice(0, 8000));
      let inserted = 0;
      for (const t of extracted.todos ?? []) {
        insertSuggestion(db, {
          file_path: safe,
          heading: t.heading ?? null,
          text: t.text,
          kind: 'suggested',
          source_quote: null,
          confidence: 0.7,
          maybe_done_for_hash: null,
          duplicate_of_hash: null,
        });
        inserted++;
      }
      res.json({ inserted, suggestions: extracted.todos ?? [] });
    } catch (e) {
      if (e instanceof LLMUnavailable) return void res.status(503).json({ error: 'ollama not reachable' });
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ---- Memory ----
  app.get('/api/memory', (_req: Request, res: Response) => {
    res.json({ items: memoryList(db) });
  });
  app.get('/api/memory/:key', (req: Request, res: Response) => {
    const key = String(req.params['key'] ?? '');
    if (!key) return void res.status(400).json({ error: 'key required' });
    const value = memoryGet(db, key);
    res.json({ key, value });
  });
  app.put('/api/memory/:key', (req: Request, res: Response) => {
    const key = String(req.params['key'] ?? '');
    if (!key) return void res.status(400).json({ error: 'key required' });
    const { value, source } = req.body as { value?: string; source?: string };
    if (typeof value !== 'string') return void res.status(400).json({ error: 'value (string) required' });
    memorySet(db, key, value, source);
    res.json({ ok: true });
  });

  // ============== CALENDAR BRIDGE ROUTES ==============

  app.get('/api/calendar/status', (_req: Request, res: Response) => {
    if (!calendar) return void res.json({ available: false, provider: null });
    res.json({ available: true, provider: calendar.getProviderName() });
  });

  app.post('/api/calendar/sync', async (req: Request, res: Response) => {
    if (!calendar) return void res.status(503).json({ error: 'calendar bridge not configured' });
    const weeks = Math.min(Math.max(Number(req.body?.weeks) || 3, 1), 12);
    const result = await calendar.syncIncoming(weeks);
    res.json(result);
  });

  app.post('/api/calendar/schedule', async (req: Request, res: Response) => {
    if (!calendar) return void res.status(503).json({ error: 'calendar bridge not configured' });
    const body = req.body as {
      todo_hash?: string;
      date?: string;
      start_time?: string;
      duration_minutes?: number;
      calendar_id?: string;
      title?: string;
    };
    if (!body.todo_hash || !body.date || !body.start_time || !body.duration_minutes) {
      return void res.status(400).json({ error: 'todo_hash, date, start_time, duration_minutes required' });
    }
    const row = getTodoByHash(db, body.todo_hash);
    if (!row) return void res.status(404).json({ error: `No todo with hash ${body.todo_hash}` });
    const result = await calendar.scheduleTask({
      todo_hash: body.todo_hash,
      date: body.date,
      start_time: body.start_time,
      duration_minutes: body.duration_minutes,
      calendar_id: body.calendar_id ?? 'primary',
      title: body.title ?? `[Task] ${row.plain_text.slice(0, 80)}`,
    });
    if (!result.ok) return void res.status(500).json(result);
    res.json(result);
  });

  app.get('/api/calendar/slots', (req: Request, res: Response) => {
    if (!calendar) return void res.status(503).json({ error: 'calendar bridge not configured' });
    const durationMinutes = Number(req.query['duration_minutes']);
    const startDate = (req.query['start_date'] as string | undefined) ?? new Date().toISOString().slice(0, 10);
    const endDate = (req.query['end_date'] as string | undefined) ??
      new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    if (!durationMinutes) return void res.status(400).json({ error: 'duration_minutes required' });
    const slots = calendar.findSlots({
      duration_minutes: durationMinutes,
      start_date: startDate,
      end_date: endDate,
      max_results: Math.min(Number(req.query['max_results']) || 10, 50),
    });
    res.json({ slots, count: slots.length });
  });
}

