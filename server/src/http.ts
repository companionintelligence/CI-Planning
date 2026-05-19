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
  LLMUnavailable,
} from './llm.js';
import type { TodoRowDb, TodoFilter } from './types.js';

export interface HttpServerDeps {
  db: Database.Database;
  directories: string[];
  excludeDirs: Set<string>;
  config: Record<string, unknown>;
  title: string;
  port: number;
  sseClients: Set<Response>;
  notifyClients: (event: string, data: unknown) => void;
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
  const { db, directories, excludeDirs, config, title, port, sseClients, notifyClients } = deps;

  const check = (p: string) => expandAndCheck(p, directories);
  const rootFor = (p: string) => rootForPath(p, directories);

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
}

