/**
 * MCP server — exposes the same primitives the HTTP API uses.
 * Run via: node server/dist/mcp-stdio.js  (stdio transport for Claude Code / agents)
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, existsSync } from 'fs';
import { sep, basename } from 'path';
import type Database from 'better-sqlite3';

import { expandPath, isPathInRoots, atomicWrite } from './util.js';
import type { TodoFilter } from './types.js';
import { listFiles, queryTodos, searchFts, getTodoByHash, getStats } from './db.js';
import { fullScan, indexFile } from './indexer.js';
import { parseFile, toggleTodoByHash, appendUnderHeading, hashTodo, sha256 } from './markdown.js';
import {
  ollamaAvailable,
  triageTodos,
  summarizeDay,
  extractTodosFromText,
  projectRollup,
  proposeArchive,
  LLMUnavailable,
} from './llm.js';
import { rewriteTodoByHash } from './markdown.js';

export interface McpServerDeps {
  db: Database.Database;
  directories: string[];
  excludeDirs: Set<string>;
}

type McpResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(text: string, data?: unknown): McpResult {
  const out: McpResult = { content: [{ type: 'text', text }] };
  if (data !== undefined) out.structuredContent = data as Record<string, unknown>;
  return out;
}
function mcpErr(message: string): McpResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

export function buildMcpServer({ db, directories, excludeDirs }: McpServerDeps): McpServer {
  const server = new McpServer({ name: 'companion-planning', version: '2.0.0' });

  function expandAndCheck(filePath: string): string {
    const safe = expandPath(filePath);
    if (!isPathInRoots(safe, directories)) {
      throw new Error(`Path not in configured roots: ${filePath}`);
    }
    return safe;
  }

  function rootForPath(p: string): string | undefined {
    return directories.find(d => p === d || p.startsWith(d + sep));
  }

  // ---------- list_files ----------
  server.registerTool('list_files', {
    title: 'List indexed markdown files',
    description: 'Returns all markdown files under the configured roots with todo counts.',
    inputSchema: {
      contains: z.string().optional().describe('Filter to files whose name or relative path contains this substring'),
      limit: z.number().int().positive().max(1000).optional(),
    },
  }, async ({ contains, limit = 200 }) => {
    let rows = listFiles(db);
    if (contains) {
      const needle = contains.toLowerCase();
      rows = rows.filter(r =>
        r.name.toLowerCase().includes(needle) || r.relativePath.toLowerCase().includes(needle),
      );
    }
    rows = rows.slice(0, limit);
    const summary = rows.map(r => `${r.relativePath}  open=${r.open ?? 0} done=${r.done ?? 0}`).join('\n');
    return ok(`Found ${rows.length} files:\n${summary}`, { files: rows });
  });

  // ---------- read_file ----------
  server.registerTool('read_file', {
    title: 'Read a markdown file',
    description: 'Returns content, sha256, and parsed todos & headings.',
    inputSchema: { path: z.string() },
  }, async ({ path }) => {
    try {
      const safe = expandAndCheck(path);
      if (!existsSync(safe)) return mcpErr(`File not found: ${safe}`);
      const content = readFileSync(safe, 'utf-8');
      const parsed = parseFile(safe, content);
      return ok(content, { path: safe, sha256: parsed.contentSha, todos: parsed.todos, headings: parsed.headings, frontmatter: parsed.frontmatter });
    } catch (e) { return mcpErr((e as Error).message); }
  });

  // ---------- write_file ----------
  server.registerTool('write_file', {
    title: 'Write/overwrite a markdown file',
    description: 'Atomic write. Rejected on sha256 mismatch (concurrent-edit guard).',
    inputSchema: { path: z.string(), content: z.string(), expected_sha256: z.string().optional() },
  }, async ({ path, content, expected_sha256 }) => {
    try {
      const safe = expandAndCheck(path);
      if (expected_sha256 && existsSync(safe)) {
        const curr = readFileSync(safe, 'utf-8');
        if (sha256(curr) !== expected_sha256) return mcpErr('sha256 mismatch — file changed since you read it');
      }
      atomicWrite(safe, content);
      const root = rootForPath(safe);
      if (root) indexFile(db, safe, root);
      return ok(`Wrote ${safe} (${content.length} bytes)`, { path: safe, sha256: sha256(content) });
    } catch (e) { return mcpErr((e as Error).message); }
  });

  // ---------- append_section ----------
  server.registerTool('append_section', {
    title: 'Append content under a heading',
    description: 'Creates the heading at end of file if missing.',
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
    } catch (e) { return mcpErr((e as Error).message); }
  });

  // ---------- list_todos ----------
  server.registerTool('list_todos', {
    title: 'Query todos with filters',
    description: 'List todos filtered by state, due bucket, tag, file, or free-text.',
    inputSchema: {
      status: z.enum(['open', 'done', 'all']).optional().default('open'),
      due: z.enum(['today', 'overdue', 'this_week']).optional(),
      tag: z.string().optional(),
      file: z.string().optional(),
      q: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  }, async (args) => {
    const filter: TodoFilter = { limit: args.limit ?? 100 };
    if (args.status !== 'all') filter.checked = args.status === 'done' ? 1 : 0;
    if (args.due) filter.due = args.due;
    if (args.tag) filter.tag = args.tag;
    if (args.file) filter.file = expandAndCheck(args.file);
    if (args.q) filter.q = args.q;
    const rows = queryTodos(db, filter);
    const summary = rows
      .map(r =>
        `[${r.checked ? 'x' : ' '}] ${r.hash}  ${r.plain_text}  (${basename(r.file_path)} / ${r.heading ?? '-'})${r.due_date ? ` due=${r.due_date}` : ''}`,
      )
      .join('\n');
    return ok(`${rows.length} todos\n${summary}`, { todos: rows });
  });

  // ---------- add_todo ----------
  server.registerTool('add_todo', {
    title: 'Add a new todo under a heading',
    description: 'Appends a `- [ ] text` line. Creates the heading if missing.',
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
      if (tags?.length) line += ' ' + tags.map(t => `#${t}`).join(' ');
      if (due) line += ` (due: ${due})`;
      const next = appendUnderHeading(cur, heading, line);
      atomicWrite(safe, next);
      const root = rootForPath(safe);
      if (root) indexFile(db, safe, root);
      const hash = hashTodo(safe, heading, line.replace(/^- \[ \] /, ''));
      return ok(`Added todo ${hash} under "${heading}" in ${safe}`, { hash, path: safe });
    } catch (e) { return mcpErr((e as Error).message); }
  });

  // ---------- complete_todo / uncomplete_todo ----------
  function makeToggle(name: string, title: string, checked: boolean): void {
    server.registerTool(name, {
      title,
      description: `${title} (stable hash from list_todos / read_file).`,
      inputSchema: { hash: z.string() },
    }, async ({ hash }) => {
      const row = getTodoByHash(db, hash);
      if (!row) return mcpErr(`No todo with hash ${hash}`);
      const safe = row.file_path;
      const content = readFileSync(safe, 'utf-8');
      const result = toggleTodoByHash(content, hash, safe, checked);
      if ('error' in result) return mcpErr(result.error);
      if (!result.noop) {
        atomicWrite(safe, result.content);
        const root = rootForPath(safe);
        if (root) indexFile(db, safe, root);
      }
      return ok(`${result.noop ? 'No change (already)' : 'Toggled'} ${hash} → ${checked ? 'done' : 'open'} in ${basename(safe)}`);
    });
  }
  makeToggle('complete_todo', 'Mark a todo as done', true);
  makeToggle('uncomplete_todo', 'Mark a todo as open', false);

  // ---------- search ----------
  server.registerTool('search', {
    title: 'Full-text search across all indexed markdown',
    description: 'BM25-ranked FTS5 search.',
    inputSchema: { q: z.string(), limit: z.number().int().positive().max(200).optional() },
  }, async ({ q, limit = 25 }) => {
    try {
      const results = searchFts(db, q, limit);
      const summary = results.map(r => `${r.path}\n  ${r.snippet}`).join('\n\n');
      return ok(`${results.length} hits for "${q}"\n\n${summary}`, { results });
    } catch (e) { return mcpErr(`FTS error: ${(e as Error).message}`); }
  });

  // ---------- stats ----------
  server.registerTool('stats', {
    title: 'Summary counts (files, todos, overdue, due today)',
    description: 'Aggregate stats from the index.',
    inputSchema: {},
  }, async () => {
    const s = getStats(db);
    return ok(JSON.stringify(s, null, 2), s);
  });

  // ---------- triage_inbox ----------
  server.registerTool('triage_inbox', {
    title: 'Run a local-LLM triage pass and return suggestions',
    description: 'Returns suggested actions. Never writes — caller must apply.',
    inputSchema: {
      file: z.string().optional().describe('Limit to one file'),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(150).optional(),
    },
  }, async ({ file, tag, limit = 50 }) => {
    try {
      const filter: TodoFilter = { checked: 0, limit };
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
      return ok(
        `Triage of ${rows.length} todos (model ${result.model}):\n${JSON.stringify(result.actions ?? result, null, 2)}`,
        result,
      );
    } catch (e) {
      if (e instanceof LLMUnavailable) return mcpErr('Ollama is not reachable (start with `ollama serve`).');
      return mcpErr((e as Error).message);
    }
  });

  // ---------- summarize_day ----------
  server.registerTool('summarize_day', {
    title: 'Daily briefing produced by local LLM',
    description: 'Prose briefing covering overdue, due-today, and notable open items.',
    inputSchema: { date: z.string().optional() },
  }, async ({ date }) => {
    try {
      const rows = queryTodos(db, { checked: 0, limit: 200 });
      const sumOpts: { date?: string } = {};
      if (date) sumOpts.date = date;
      const result = await summarizeDay(rows, sumOpts);
      return ok(result.text, result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return mcpErr('Ollama is not reachable.');
      return mcpErr((e as Error).message);
    }
  });

  // ---------- rescan ----------
  server.registerTool('rescan', {
    title: 'Force a full re-index of configured roots',
    description: 'Cache-hits skip unchanged files.',
    inputSchema: {},
  }, async () => {
    const t0 = Date.now();
    const stats = fullScan(db, directories, excludeDirs);
    return ok(`Re-scan complete in ${Date.now() - t0}ms: ${JSON.stringify(stats)}`, stats);
  });

  // ---------- extract_todos_from_text ----------
  server.registerTool('extract_todos_from_text', {
    title: 'Extract todos from freeform text using LLM',
    description: 'Parses a block of prose or notes and returns structured todo items. Nothing is written — caller adds todos via add_todo.',
    inputSchema: { text: z.string().max(8000) },
  }, async ({ text }) => {
    try {
      const result = await extractTodosFromText(text);
      const summary = result.todos.map((t, i) =>
        `${i + 1}. ${t.text}${t.heading ? ` [${t.heading}]` : ''}${t.due ? ` due=${t.due}` : ''}`
      ).join('\n');
      return ok(`Extracted ${result.todos.length} todos:\n${summary}`, result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return mcpErr('Ollama is not reachable.');
      return mcpErr((e as Error).message);
    }
  });

  // ---------- project_rollup ----------
  server.registerTool('project_rollup', {
    title: 'Per-section narrative rollup of a file\'s todos',
    description: 'Produces a 1-2 sentence summary per heading section. Useful for project status overviews.',
    inputSchema: {
      file: z.string().optional().describe('Limit rollup to one file'),
      limit: z.number().int().positive().max(500).optional(),
    },
  }, async ({ file, limit = 200 }) => {
    try {
      const filter: TodoFilter = { limit };
      if (file) filter.file = expandAndCheck(file);
      const todos = queryTodos(db, filter);
      const fileTitle = file ? file.split('/').slice(-1)[0] : undefined;
      const rollupOpts: { title?: string } = {}; if (fileTitle) rollupOpts.title = fileTitle; const result = await projectRollup(todos, rollupOpts);
      return ok(result.text, result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return mcpErr('Ollama is not reachable.');
      return mcpErr((e as Error).message);
    }
  });

  // ---------- propose_archive ----------
  server.registerTool('propose_archive', {
    title: 'Propose stale todos as archive candidates',
    description: 'Returns todos that appear stale or no longer relevant. Nothing is written — use apply_suggestion or complete_todo to act.',
    inputSchema: {
      file: z.string().optional(),
      limit: z.number().int().positive().max(150).optional(),
    },
  }, async ({ file, limit = 80 }) => {
    try {
      const filter: TodoFilter = { checked: 0, limit };
      if (file) filter.file = expandAndCheck(file);
      const todos = queryTodos(db, filter);
      const result = await proposeArchive(todos.map(r => ({
        hash: r.hash,
        relativePath: r.file_path,
        heading: r.heading,
        plainText: r.plain_text,
      })));
      const summary = result.proposals.map(p => `${p.hash}  ${p.reason}`).join('\n');
      return ok(`${result.proposals.length} archive proposals:\n${summary}`, result);
    } catch (e) {
      if (e instanceof LLMUnavailable) return mcpErr('Ollama is not reachable.');
      return mcpErr((e as Error).message);
    }
  });

  // ---------- apply_suggestion ----------
  server.registerTool('apply_suggestion', {
    title: 'Apply a single LLM suggestion to a todo',
    description: 'The only write path for LLM-proposed mutations. Supported actions: archive (mark done), rewrite (replace text), add_tag, set_due.',
    inputSchema: {
      hash: z.string().describe('Todo hash from list_todos / triage results'),
      action: z.enum(['archive', 'mark_done', 'rewrite', 'add_tag', 'set_due']),
      new_text: z.string().optional().describe('Required for rewrite'),
      tag: z.string().optional().describe('Required for add_tag'),
      due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Required for set_due'),
    },
  }, async ({ hash, action, new_text, tag, due }) => {
    try {
      const row = getTodoByHash(db, hash);
      if (!row) return mcpErr(`No todo with hash ${hash}`);
      const safe = row.file_path;
      const content = readFileSync(safe, 'utf-8');

      let result;
      if (action === 'archive' || action === 'mark_done') {
        result = toggleTodoByHash(content, hash, safe, true);
      } else if (action === 'rewrite' && new_text) {
        result = rewriteTodoByHash(content, hash, safe, new_text);
      } else if (action === 'add_tag' && tag) {
        result = rewriteTodoByHash(content, hash, safe, `${row.text} #${tag}`);
      } else if (action === 'set_due' && due) {
        const clean = row.text.replace(/\s*\(due:\s*\d{4}-\d{2}-\d{2}\)/i, '').trim();
        result = rewriteTodoByHash(content, hash, safe, `${clean} (due: ${due})`);
      } else {
        return mcpErr(`Action "${action}" requires additional parameter (new_text/tag/due)`);
      }

      if ('error' in result) return mcpErr(result.error);
      if (!result.noop) {
        atomicWrite(safe, result.content);
        const root = rootForPath(safe);
        if (root) indexFile(db, safe, root);
      }
      return ok(
        `${result.noop ? 'No change needed' : `Applied ${action}`} on ${hash} in ${basename(safe)}`,
        { ok: true, noop: result.noop, hash },
      );
    } catch (e) { return mcpErr((e as Error).message); }
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
