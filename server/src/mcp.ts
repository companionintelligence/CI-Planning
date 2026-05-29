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
import {
  listFiles,
  queryTodos,
  searchFts,
  getTodoByHash,
  getStats,
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

import type { CalendarBridge } from './calendar.js';
import { generateSummary, reconcilePast, lastSummaries, type Period } from './summary.js';

export interface McpServerDeps {
  db: Database.Database;
  directories: string[];
  excludeDirs: Set<string>;
  calendar?: CalendarBridge;
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

export function buildMcpServer({ db, directories, excludeDirs, calendar }: McpServerDeps): McpServer {
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

  // ============== V4 TOOLS ==============

  // ---------- extract_from_source ----------
  server.registerTool('extract_from_source', {
    title: 'Extract actionable tasks from a markdown file (prose-aware)',
    description: 'Runs LLM pass-2 extraction on a file. Returns suggested tasks for the Review queue; nothing is auto-applied.',
    inputSchema: {
      path: z.string().describe('Path to a markdown file inside a configured root'),
    },
  }, async ({ path: filePath }: { path: string }) => {
    try {
      const safe = expandAndCheck(filePath);
      if (!existsSync(safe)) return mcpErr(`File not found: ${safe}`);
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
      return ok(`Extracted ${inserted} suggested task${inserted === 1 ? '' : 's'} from ${basename(safe)}`, {
        inserted,
        suggestions: extracted.todos ?? [],
      });
    } catch (e) {
      if (e instanceof LLMUnavailable) return mcpErr('Ollama not reachable');
      return mcpErr((e as Error).message);
    }
  });

  // ---------- list_suggestions ----------
  server.registerTool('list_suggestions', {
    title: 'List pending suggested tasks from the Review queue',
    description: 'Returns Review queue items — suggested tasks, maybe-done flags, duplicates. Nothing is applied automatically.',
    inputSchema: {
      status: z.enum(['pending', 'accepted', 'dismissed']).optional().describe('Defaults to pending'),
    },
  }, async (args: { status?: 'pending' | 'accepted' | 'dismissed' | undefined }) => {
    const status = args.status ?? 'pending';
    const items = listSuggestions(db, status);
    return ok(`${items.length} suggestion${items.length === 1 ? '' : 's'} ${status}`, { items });
  });

  // ---------- accept_suggestion ----------
  server.registerTool('accept_suggestion', {
    title: 'Accept a Review-queue suggestion — writes the task into its file',
    description: 'For suggested tasks: appends under the inferred heading. For maybe_done: marks the existing todo done. For duplicates: closes the suggestion without changing files.',
    inputSchema: {
      id: z.number().describe('suggestion id from list_suggestions'),
    },
  }, async ({ id }: { id: number }) => {
    try {
      const s = getSuggestion(db, id);
      if (!s) return mcpErr(`No suggestion ${id}`);
      if (s.status !== 'pending') return mcpErr(`Suggestion ${id} already ${s.status}`);

      if (s.kind === 'suggested') {
        const content = existsSync(s.file_path) ? readFileSync(s.file_path, 'utf-8') : '';
        const heading = s.heading ?? 'Inbox';
        const line = `- [ ] ${s.text}`;
        const updated = appendUnderHeading(content, heading, line);
        atomicWrite(s.file_path, updated);
        const root = rootForPath(s.file_path);
        if (root) indexFile(db, s.file_path, root);
        const hash = hashTodo(s.file_path, heading, s.text);
        logTaskEvent(db, hash, 'created', 'agent:accept_suggestion', { suggestion_id: id });
        updateSuggestionStatus(db, id, 'accepted');
        return ok(`Accepted suggestion ${id} — added under ${heading}`, { ok: true, hash });
      }

      if (s.kind === 'maybe_done' && s.maybe_done_for_hash) {
        const row = getTodoByHash(db, s.maybe_done_for_hash);
        if (!row) return mcpErr('Target todo not found');
        const content = readFileSync(row.file_path, 'utf-8');
        const result = toggleTodoByHash(content, s.maybe_done_for_hash, row.file_path, true);
        if ('error' in result) return mcpErr(result.error);
        if (!result.noop) {
          atomicWrite(row.file_path, result.content);
          const root = rootForPath(row.file_path);
          if (root) indexFile(db, row.file_path, root);
        }
        logTaskEvent(db, s.maybe_done_for_hash, 'completed', 'agent:accept_suggestion', { suggestion_id: id });
        updateSuggestionStatus(db, id, 'accepted');
        return ok(`Marked ${s.maybe_done_for_hash} done`, { ok: true, hash: s.maybe_done_for_hash });
      }

      if (s.kind === 'duplicate') {
        // Just dismiss — there's no write needed
        updateSuggestionStatus(db, id, 'accepted');
        return ok('Duplicate suggestion closed (no file change)', { ok: true });
      }

      return mcpErr(`Unknown suggestion kind: ${s.kind}`);
    } catch (e) { return mcpErr((e as Error).message); }
  });

  // ---------- dismiss_suggestion ----------
  server.registerTool('dismiss_suggestion', {
    title: 'Dismiss a Review-queue suggestion without writing files',
    description: 'Removes the suggestion from the pending Review queue.',
    inputSchema: {
      id: z.number(),
    },
  }, async ({ id }: { id: number }) => {
    const s = getSuggestion(db, id);
    if (!s) return mcpErr(`No suggestion ${id}`);
    updateSuggestionStatus(db, id, 'dismissed');
    return ok(`Dismissed suggestion ${id}`, { ok: true });
  });

  // ---------- task_history ----------
  server.registerTool('task_history', {
    title: 'Audit trail for one task — when created, when toggled, when scheduled',
    description: 'Returns task_events rows for the given todo hash in reverse-chronological order.',
    inputSchema: {
      hash: z.string(),
    },
  }, async ({ hash }: { hash: string }) => {
    const events = getTaskEvents(db, hash);
    return ok(`${events.length} event${events.length === 1 ? '' : 's'} for ${hash}`, { events });
  });

  // ---------- set_estimate ----------
  server.registerTool('set_estimate', {
    title: 'Set estimated minutes for a task',
    description: 'Stores estimated_minutes on the todo row. Used by capacity calculations.',
    inputSchema: {
      hash: z.string(),
      minutes: z.number().int().positive(),
    },
  }, ({ hash, minutes }: { hash: string; minutes: number }) => {
    const row = getTodoByHash(db, hash);
    if (!row) return mcpErr(`No todo with hash ${hash}`);
    db.prepare(`UPDATE todos SET estimated_minutes=? WHERE hash=?`).run(minutes, hash);
    logTaskEvent(db, hash, 'estimated', 'user', { minutes });
    return ok(`Set ${minutes}m estimate on ${hash}`, { ok: true, minutes });
  });

  // ---------- capacity_report ----------
  server.registerTool('capacity_report', {
    title: 'Day-by-day capacity for a date range',
    description: 'Returns committed minutes (from calendar_links), task counts due, and unscheduled-task counts.',
    inputSchema: {
      start_date: z.string().describe('YYYY-MM-DD'),
      end_date: z.string().describe('YYYY-MM-DD'),
      workday_minutes: z.number().int().positive().optional(),
    },
  }, (args: { start_date: string; end_date: string; workday_minutes?: number | undefined }) => {
    const { start_date, end_date } = args;
    const wm = args.workday_minutes ?? 480;
    const days = dailyCapacity(db, start_date, end_date, wm).map(d => ({
      ...d,
      capacity_pct: Math.round((d.committed_minutes / wm) * 100),
      workday_minutes: wm,
    }));
    return ok(`${days.length} days from ${start_date} to ${end_date}`, { days, workday_minutes: wm });
  });

  // ---------- lookahead ----------
  server.registerTool('lookahead', {
    title: 'Day-by-day capacity + tasks + events for the next N weeks',
    description: 'Like capacity_report but starts today and runs N weeks ahead. Default 3 weeks.',
    inputSchema: {
      weeks: z.number().int().positive().max(12).optional(),
      workday_minutes: z.number().int().positive().optional(),
    },
  }, (args: { weeks?: number | undefined; workday_minutes?: number | undefined }) => {
    const wm = args.workday_minutes ?? 480;
    const n = args.weeks ?? 3;
    const startMs = Date.now();
    const start = new Date(startMs);
    const end = new Date(startMs + n * 7 * 86400000);
    const s = start.toISOString().slice(0, 10);
    const e = end.toISOString().slice(0, 10);
    const days = dailyCapacity(db, s, e, wm).map(d => ({
      ...d,
      capacity_pct: Math.round((d.committed_minutes / wm) * 100),
      over_capacity: d.committed_minutes > wm,
      workday_minutes: wm,
    }));
    const overDays = days.filter(d => d.over_capacity).length;
    return ok(`Lookahead ${n} weeks: ${overDays} over-capacity day${overDays === 1 ? '' : 's'}`, { days, weeks: n, workday_minutes: wm });
  });

  // ---------- list_calendar ----------
  server.registerTool('list_calendar', {
    title: 'Calendar links (events synced from Google Calendar) in a date range',
    description: 'Returns calendar_links rows. Use sync_calendar (Phase 2) to refresh.',
    inputSchema: {
      start_date: z.string(),
      end_date: z.string(),
    },
  }, ({ start_date, end_date }: { start_date: string; end_date: string }) => {
    const startMs = new Date(start_date + 'T00:00:00').getTime();
    const endMs = new Date(end_date + 'T23:59:59').getTime();
    const links = listCalendarLinksInRange(db, startMs, endMs);
    return ok(`${links.length} calendar link${links.length === 1 ? '' : 's'}`, { links });
  });

  // ---------- memory_set ----------
  server.registerTool('memory_set', {
    title: 'Store a persistent fact for the planning agent',
    description: 'Use for facts that should survive across sessions: preferences, key relationships, contexts.',
    inputSchema: {
      key: z.string(),
      value: z.string(),
      source: z.string().optional(),
    },
  }, (args: { key: string; value: string; source?: string | undefined }) => {
    memorySet(db, args.key, args.value, args.source);
    return ok(`Stored memory ${args.key}`, { ok: true });
  });

  // ---------- memory_get ----------
  server.registerTool('memory_get', {
    title: 'Retrieve a persistent memory value',
    description: 'Read what memory_set stored. Returns null if the key does not exist.',
    inputSchema: { key: z.string() },
  }, ({ key }: { key: string }) => {
    const value = memoryGet(db, key);
    return ok(value === null ? `(empty) ${key}` : `${key}: ${value}`, { key, value });
  });

  // ---------- memory_list ----------
  server.registerTool('memory_list', {
    title: 'List all persistent memory entries',
    description: 'Returns all memory keys with values, most-recently-updated first.',
    inputSchema: {},
  }, () => {
    const items = memoryList(db);
    return ok(`${items.length} memory entries`, { items });
  });

  // ---------- sync_calendar ----------
  server.registerTool('sync_calendar', {
    title: 'Pull calendar events from the bound provider into calendar_links',
    description: 'Default 3 weeks ahead. Updates committed-minutes for the capacity report.',
    inputSchema: { weeks: z.number().int().positive().max(12).optional() },
  }, async (args: { weeks?: number | undefined }) => {
    if (!calendar) return mcpErr('Calendar bridge not configured');
    const result = await calendar.syncIncoming(args.weeks ?? 3);
    return ok(
      result.ok
        ? `Synced ${result.new_events} new, ${result.updated_events} updated, ${result.removed_events} removed`
        : `Sync failed: ${result.error}`,
      result as unknown as Record<string, unknown>,
    );
  });

  // ---------- schedule_task ----------
  server.registerTool('schedule_task', {
    title: 'Create a calendar block linked to a task',
    description: 'Creates a calendar event (via the bound provider) and stamps calendar_event_id on the todo.',
    inputSchema: {
      hash: z.string(),
      date: z.string().describe('YYYY-MM-DD'),
      start_time: z.string().describe('HH:MM (24h, local)'),
      duration_minutes: z.number().int().positive(),
      calendar_id: z.string().optional(),
      title: z.string().optional(),
    },
  }, async (args: {
    hash: string;
    date: string;
    start_time: string;
    duration_minutes: number;
    calendar_id?: string | undefined;
    title?: string | undefined;
  }) => {
    if (!calendar) return mcpErr('Calendar bridge not configured');
    const row = getTodoByHash(db, args.hash);
    if (!row) return mcpErr(`No todo with hash ${args.hash}`);
    const result = await calendar.scheduleTask({
      todo_hash: args.hash,
      date: args.date,
      start_time: args.start_time,
      duration_minutes: args.duration_minutes,
      calendar_id: args.calendar_id ?? 'primary',
      title: args.title ?? `[Task] ${row.plain_text.slice(0, 80)}`,
    });
    if (!result.ok) return mcpErr(result.error ?? 'schedule failed');
    return ok(`Scheduled ${args.hash} on ${args.date} ${args.start_time} for ${args.duration_minutes}m`, result as unknown as Record<string, unknown>);
  });

  // ---------- generate_summary ----------
  server.registerTool('generate_summary', {
    title: 'Generate a daily/weekly/monthly review and write it to a Summaries file',
    description: 'Queries completed/overdue/upcoming todos + calendar events for the period, writes an LLM-authored (or templated) review into <root>/Summaries/<Period>/<key>.md. Use for scheduled routines.',
    inputSchema: {
      period: z.enum(['daily', 'weekly', 'monthly']),
      date: z.string().optional().describe('Anchor YYYY-MM-DD, defaults to today (local)'),
      model: z.string().optional(),
    },
  }, async (args: { period: Period; date?: string | undefined; model?: string | undefined }) => {
    const root = directories[0] ?? process.cwd();
    const anchor = args.date ?? new Date().toLocaleDateString('en-CA');
    const opts = args.model ? { model: args.model } : {};
    const result = await generateSummary(db, root, args.period, anchor, opts);
    const r = rootForPath(result.filePath);
    if (r) indexFile(db, result.filePath, r);
    return ok(
      `${args.period} review for ${result.window.key} → ${basename(result.filePath)} (${result.data.counts.completed} done, ${result.data.counts.overdue} overdue)`,
      { key: result.window.key, file: result.filePath, model: result.model, counts: result.data.counts, text: result.text },
    );
  });

  // ---------- reconcile_past ----------
  server.registerTool('reconcile_past', {
    title: 'Close past calendar blocks whose task is done; report overdue count',
    description: 'Marks calendar_links in the past as completed when their linked todo is checked. Returns counts. Safe to run on a schedule.',
    inputSchema: {},
  }, () => {
    const result = reconcilePast(db);
    return ok(`Closed ${result.events_completed} past blocks; ${result.overdue_now} overdue now`, result as unknown as Record<string, unknown>);
  });

  // ---------- last_summaries ----------
  server.registerTool('last_summaries', {
    title: 'When each period summary last ran',
    description: 'Returns the last daily/weekly/monthly summary key, timestamp, and file.',
    inputSchema: {},
  }, () => {
    const last = lastSummaries(db);
    return ok('Last summary runs', { last } as unknown as Record<string, unknown>);
  });

  // ---------- find_slot ----------
  server.registerTool('find_slot', {
    title: 'Find open calendar slots that fit a given duration',
    description: 'Considers busy time from calendar_links within a workday window. Returns slots sorted earliest first.',
    inputSchema: {
      duration_minutes: z.number().int().positive(),
      start_date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
      end_date: z.string().optional().describe('YYYY-MM-DD, defaults to +7 days'),
      workday_start: z.string().optional().describe('HH:MM, default 09:00'),
      workday_end: z.string().optional().describe('HH:MM, default 17:00'),
      max_results: z.number().int().positive().max(50).optional(),
    },
  }, (args: {
    duration_minutes: number;
    start_date?: string | undefined;
    end_date?: string | undefined;
    workday_start?: string | undefined;
    workday_end?: string | undefined;
    max_results?: number | undefined;
  }) => {
    if (!calendar) return mcpErr('Calendar bridge not configured');
    const today = new Date().toISOString().slice(0, 10);
    const inSeven = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const slots = calendar.findSlots({
      duration_minutes: args.duration_minutes,
      start_date: args.start_date ?? today,
      end_date: args.end_date ?? inSeven,
      workday_start: args.workday_start ?? '09:00',
      workday_end: args.workday_end ?? '17:00',
      max_results: args.max_results ?? 10,
    });
    return ok(`${slots.length} slot${slots.length === 1 ? '' : 's'} found`, { slots });
  });

  return server;
}
