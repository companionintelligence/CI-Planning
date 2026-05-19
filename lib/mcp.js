/**
 * MCP server — exposes the same todo/file primitives the HTTP API uses.
 * Run via: node mcp-stdio.js  (stdio transport for Claude Code / agents)
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { resolve, sep, basename } from 'path';

import { expandPath, isPathInRoots } from './util.js';
import { openDb, listFiles, queryTodos, searchFts, getTodoByHash } from './db.js';
import { fullScan, indexFile } from './indexer.js';
import { parseFile, toggleTodoByHash, appendUnderHeading, hashTodo, sha256 } from './markdown.js';
import { ollamaAvailable, triageTodos, summarizeDay, LLMUnavailable } from './llm.js';

export function buildMcpServer({ db, directories, excludeDirs }) {
  const server = new McpServer({ name: 'liam-plan', version: '2.0.0' });

  function expandAndCheck(filePath) {
    const safe = resolve(expandPath(filePath));
    if (!isPathInRoots(safe, directories)) {
      throw new Error(`Path not in configured roots: ${filePath}`);
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

  function ok(text, data) {
    const out = { content: [{ type: 'text', text }] };
    if (data !== undefined) out.structuredContent = data;
    return out;
  }
  function err(message) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
  }

  // ---------- list_files ----------
  server.registerTool('list_files', {
    title: 'List indexed markdown files',
    description:
      'Returns all markdown files under the configured roots with todo counts. Optional filter by name substring.',
    inputSchema: {
      contains: z.string().optional().describe('Filter to files whose name or relative path contains this substring'),
      limit: z.number().int().positive().max(1000).optional(),
    },
  }, async ({ contains, limit = 200 }) => {
    let rows = listFiles(db);
    if (contains) {
      const needle = contains.toLowerCase();
      rows = rows.filter(r => r.name.toLowerCase().includes(needle) || r.relativePath.toLowerCase().includes(needle));
    }
    rows = rows.slice(0, limit);
    const summary = rows
      .map(r => `${r.relativePath}  open=${r.open} done=${r.done}`)
      .join('\n');
    return ok(`Found ${rows.length} files:\n${summary}`, { files: rows });
  });

  // ---------- read_file ----------
  server.registerTool('read_file', {
    title: 'Read a markdown file',
    description: 'Read a file under one of the configured roots. Returns content, sha256, and parsed todos & headings.',
    inputSchema: { path: z.string() },
  }, async ({ path }) => {
    try {
      const safe = expandAndCheck(path);
      if (!existsSync(safe)) return err(`File not found: ${safe}`);
      const content = readFileSync(safe, 'utf-8');
      const parsed = parseFile(safe, content);
      return ok(content, {
        path: safe,
        sha256: parsed.contentSha,
        todos: parsed.todos,
        headings: parsed.headings,
        frontmatter: parsed.frontmatter,
      });
    } catch (e) { return err(e.message); }
  });

  // ---------- write_file ----------
  server.registerTool('write_file', {
    title: 'Write/overwrite a markdown file',
    description: 'Atomic write. If expected_sha256 is provided, write is rejected on mismatch (concurrent-edit guard).',
    inputSchema: {
      path: z.string(),
      content: z.string(),
      expected_sha256: z.string().optional(),
    },
  }, async ({ path, content, expected_sha256 }) => {
    try {
      const safe = expandAndCheck(path);
      if (expected_sha256 && existsSync(safe)) {
        const curr = readFileSync(safe, 'utf-8');
        if (sha256(curr) !== expected_sha256) return err('sha256 mismatch — file changed since you read it');
      }
      atomicWrite(safe, content);
      const root = rootForPath(safe);
      if (root) indexFile(db, safe, root);
      return ok(`Wrote ${safe} (${content.length} bytes)`, { path: safe, sha256: sha256(content) });
    } catch (e) { return err(e.message); }
  });

  // ---------- append_section ----------
  server.registerTool('append_section', {
    title: 'Append content under a heading',
    description: 'Append the given markdown under the named heading. Heading is created at end of file if missing.',
    inputSchema: { path: z.string(), heading: z.string(), content: z.string() },
  }, async ({ path, heading, content }) => {
    try {
      const safe = expandAndCheck(path);
      const cur = existsSync(safe) ? readFileSync(safe, 'utf-8') : '';
      const next = appendUnderHeading(cur, heading, content);
      atomicWrite(safe, next);
      const root = rootForPath(safe);
      if (root) indexFile(db, safe, root);
      return ok(`Appended under "${heading}" in ${safe}`);
    } catch (e) { return err(e.message); }
  });

  // ---------- list_todos ----------
  server.registerTool('list_todos', {
    title: 'Query todos with filters',
    description:
      'List todos with optional filters: open/done state, due bucket (today|overdue|this_week), tag, file path, free-text in `q`.',
    inputSchema: {
      status: z.enum(['open', 'done', 'all']).optional().default('open'),
      due: z.enum(['today', 'overdue', 'this_week']).optional(),
      tag: z.string().optional(),
      file: z.string().optional(),
      q: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  }, async (args) => {
    const filter = {
      checked: args.status === 'done' ? 1 : args.status === 'all' ? undefined : 0,
      due: args.due,
      tag: args.tag,
      file: args.file ? expandAndCheck(args.file) : undefined,
      q: args.q,
      limit: args.limit || 100,
    };
    const rows = queryTodos(db, filter);
    const summary = rows
      .map(r => `[${r.checked ? 'x' : ' '}] ${r.hash}  ${r.plain_text}  (${basename(r.file_path)} / ${r.heading || '-'})${r.due_date ? ` due=${r.due_date}` : ''}`)
      .join('\n');
    return ok(`${rows.length} todos\n${summary}`, { todos: rows });
  });

  // ---------- add_todo ----------
  server.registerTool('add_todo', {
    title: 'Add a new todo under a heading',
    description: 'Appends a `- [ ] text` line under the named heading. Creates the heading if missing.',
    inputSchema: {
      path: z.string(),
      heading: z.string().default('Inbox'),
      text: z.string(),
      due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      tags: z.array(z.string()).optional(),
    },
  }, async ({ path, heading, text, due, tags }) => {
    try {
      const safe = expandAndCheck(path);
      const cur = existsSync(safe) ? readFileSync(safe, 'utf-8') : '';
      let line = `- [ ] ${text}`;
      if (tags && tags.length) line += ' ' + tags.map(t => `#${t}`).join(' ');
      if (due) line += ` (due: ${due})`;
      const next = appendUnderHeading(cur, heading, line);
      atomicWrite(safe, next);
      const root = rootForPath(safe);
      if (root) indexFile(db, safe, root);
      const hash = hashTodo(safe, heading, line.replace(/^- \[ \] /, ''));
      return ok(`Added todo ${hash} under "${heading}" in ${safe}`, { hash, path: safe });
    } catch (e) { return err(e.message); }
  });

  // ---------- complete_todo / uncomplete_todo ----------
  function makeToggle(name, title, checked) {
    server.registerTool(name, {
      title,
      description: `${title} (stable hash from list_todos / read_file).`,
      inputSchema: { hash: z.string() },
    }, async ({ hash }) => {
      const row = getTodoByHash(db, hash);
      if (!row) return err(`No todo with hash ${hash}`);
      const safe = row.file_path;
      const content = readFileSync(safe, 'utf-8');
      const result = toggleTodoByHash(content, hash, safe, checked);
      if (result.error) return err(result.error);
      if (!result.noop) {
        atomicWrite(safe, result.content);
        const root = rootForPath(safe);
        if (root) indexFile(db, safe, root);
      }
      return ok(`${result.noop ? 'No change (already)' : 'Toggled'} ${hash} -> ${checked ? 'done' : 'open'} in ${basename(safe)}`);
    });
  }
  makeToggle('complete_todo', 'Mark a todo as done', true);
  makeToggle('uncomplete_todo', 'Mark a todo as open', false);

  // ---------- search ----------
  server.registerTool('search', {
    title: 'Full-text search across all indexed markdown',
    description: 'BM25-ranked FTS5 search. Returns up to `limit` snippets.',
    inputSchema: { q: z.string(), limit: z.number().int().positive().max(200).optional() },
  }, async ({ q, limit = 25 }) => {
    try {
      const results = searchFts(db, q, limit);
      const summary = results
        .map(r => `${r.path}\n  ${r.snippet}`)
        .join('\n\n');
      return ok(`${results.length} hits for "${q}"\n\n${summary}`, { results });
    } catch (e) { return err(`FTS error: ${e.message}`); }
  });

  // ---------- stats ----------
  server.registerTool('stats', {
    title: 'Summary counts (files, todos, overdue, due today)',
    description: 'Returns aggregate stats from the index.',
    inputSchema: {},
  }, async () => {
    const s = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM files) AS files,
                (SELECT COUNT(*) FROM todos) AS todos_total,
                (SELECT COUNT(*) FROM todos WHERE checked=0) AS open,
                (SELECT COUNT(*) FROM todos WHERE checked=1) AS done,
                (SELECT COUNT(*) FROM todos WHERE checked=0 AND due_date IS NOT NULL AND due_date < date('now')) AS overdue,
                (SELECT COUNT(*) FROM todos WHERE checked=0 AND due_date = date('now')) AS due_today`
      )
      .get();
    return ok(JSON.stringify(s, null, 2), s);
  });

  // ---------- triage ----------
  server.registerTool('triage_inbox', {
    title: 'Run a local-LLM triage pass and return suggestions',
    description:
      'Runs Ollama on open todos and returns suggested actions (keep / archive / duplicate / rewrite / move). Never writes — caller must apply suggestions via complete_todo / write_file.',
    inputSchema: {
      file: z.string().optional().describe('Limit to one file'),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(150).optional(),
    },
  }, async ({ file, tag, limit = 50 }) => {
    try {
      const filter = { checked: 0, limit };
      if (file) filter.file = expandAndCheck(file);
      if (tag) filter.tag = tag;
      const rows = queryTodos(db, filter);
      if (!rows.length) return ok('No open todos match the filter.', { actions: [] });
      const result = await triageTodos(rows.map(r => ({
        hash: r.hash,
        relativePath: r.file_path,
        heading: r.heading,
        plainText: r.plain_text,
      })));
      return ok(`Triage of ${rows.length} todos (model ${result.model}):\n${JSON.stringify(result.actions || result, null, 2)}`, result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return err('Ollama is not reachable (start with `ollama serve`).');
      return err(e.message);
    }
  });

  // ---------- summarize_day ----------
  server.registerTool('summarize_day', {
    title: 'Daily briefing produced by local LLM',
    description: 'Returns a short prose briefing covering overdue, due-today, and notable open items.',
    inputSchema: { date: z.string().optional() },
  }, async ({ date }) => {
    try {
      const rows = queryTodos(db, { checked: 0, limit: 200 });
      const result = await summarizeDay(rows, { date });
      return ok(result.text, result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return err('Ollama is not reachable.');
      return err(e.message);
    }
  });

  // ---------- rescan ----------
  server.registerTool('rescan', {
    title: 'Force a full re-index of configured roots',
    description: 'Rebuild the SQLite index from disk (cache-hits skip unchanged files).',
    inputSchema: {},
  }, async () => {
    const t0 = Date.now();
    const stats = fullScan(db, directories, excludeDirs);
    return ok(`Re-scan complete in ${Date.now() - t0}ms: ${JSON.stringify(stats)}`, stats);
  });

  // ---------- llm_status ----------
  server.registerTool('llm_status', {
    title: 'Whether the local Ollama LLM gateway is reachable',
    description: 'Health check for triage / summary tools.',
    inputSchema: {},
  }, async () => {
    const up = await ollamaAvailable();
    return ok(up ? 'Ollama is reachable.' : 'Ollama is not reachable.', { available: up });
  });

  return server;
}
