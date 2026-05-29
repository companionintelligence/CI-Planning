// Thin Ollama HTTP client. All functions are graceful no-ops if Ollama is not running.
import type { TriageInput, TriageResult, SummaryResult, TodoRowDb } from './types.js';

const DEFAULT_HOST = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';

export class LLMUnavailable extends Error {
  constructor(message = 'Ollama not reachable') {
    super(message);
    this.name = 'LLMUnavailable';
  }
}

export async function ollamaAvailable(host = DEFAULT_HOST): Promise<boolean> {
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function listModels(host = DEFAULT_HOST): Promise<string[]> {
  const r = await fetch(`${host}/api/tags`);
  if (!r.ok) throw new LLMUnavailable('ollama not reachable');
  const j = await r.json() as { models?: Array<{ name: string }> };
  return (j.models ?? []).map(m => m.name);
}

interface GenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  format?: string | Record<string, unknown>;
  options?: Record<string, unknown>;
  host?: string;
  timeoutMs?: number;
}

interface OllamaGenerateResponse {
  response: string;
  model?: string;
  done?: boolean;
}

export async function generate(opts: GenerateOptions): Promise<OllamaGenerateResponse> {
  const { model, prompt, system, format, options, host = DEFAULT_HOST, timeoutMs = 120_000 } = opts;
  const body: Record<string, unknown> = {
    model,
    prompt,
    system,
    stream: false,
    options: { temperature: 0.2, ...(options ?? {}) },
  };
  if (format) body['format'] = format;

  const r = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`ollama ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json() as Promise<OllamaGenerateResponse>;
}

// ---- config-driven model preference + resilient generation ----

let preferredModel: string | null = process.env['OLLAMA_MODEL'] ?? null;

/** Pin a preferred model (from config.json `llm.model`). null = auto-select. */
export function setPreferredModel(model: string | null): void {
  preferredModel = model && model.trim() ? model.trim() : null;
}

/** All available models, ordered by preference, with unknowns appended. */
function orderModels(available: string[]): string[] {
  const order = [
    'qwen3.6:35b', 'nemotron3:33b', 'gemma4:31b',
    'qwen2.5:7b-instruct', 'qwen2.5:7b', 'llama3.2:3b',
    'qwen2.5:3b', 'phi4:mini', 'qwen2.5:1.5b', 'qwen2.5:0.5b',
  ];
  const ranked = available
    .map(m => ({ m, i: order.findIndex(o => m === o || m.startsWith(o + ':') || m.startsWith(o)) }))
    .sort((a, b) => (a.i < 0 ? 999 : a.i) - (b.i < 0 ? 999 : b.i))
    .map(x => x.m);
  return ranked;
}

const LOAD_FAILURE_RE = /unable to load model|ollama 5\d\d|model .* not found|no such model/i;

/**
 * Generate with model fallback. Tries the preferred/pinned model first, then
 * every other available model in preference order, skipping any that fail to
 * load. Returns the response plus the model that actually answered. Throws
 * LLMUnavailable if Ollama is down, or the last error if every model failed.
 *
 * This is what makes the agentic tools robust: a corrupted 35B blob no longer
 * breaks triage/summary/extract — they transparently fall back to a model that
 * loads (e.g. qwen2.5:0.5b).
 */
export async function generateWithFallback(opts: {
  system?: string;
  prompt: string;
  format?: string | Record<string, unknown>;
  options?: Record<string, unknown>;
  timeoutMs?: number;
  preferModel?: string;
}): Promise<{ response: string; model: string }> {
  if (!(await ollamaAvailable())) throw new LLMUnavailable();
  const available = await listModels();
  if (available.length === 0) throw new LLMUnavailable('no models installed');

  const candidates: string[] = [];
  for (const m of [opts.preferModel, preferredModel, ...orderModels(available)]) {
    if (m && available.includes(m) && !candidates.includes(m)) candidates.push(m);
    // also accept prefix matches for pinned names not exactly in the list
    else if (m && !candidates.includes(m)) {
      const hit = available.find(a => a === m || a.startsWith(m + ':'));
      if (hit && !candidates.includes(hit)) candidates.push(hit);
    }
  }

  let lastErr: Error | null = null;
  for (const model of candidates) {
    try {
      const genOpts: GenerateOptions = { model, prompt: opts.prompt };
      if (opts.system !== undefined) genOpts.system = opts.system;
      if (opts.format !== undefined) genOpts.format = opts.format;
      if (opts.options !== undefined) genOpts.options = opts.options;
      if (opts.timeoutMs !== undefined) genOpts.timeoutMs = opts.timeoutMs;
      const res = await generate(genOpts);
      return { response: res.response, model };
    } catch (e) {
      lastErr = e as Error;
      // Load/availability failure → try the next model. Anything else → also try
      // next (a model-specific timeout shouldn't abort the whole operation).
      if (!LOAD_FAILURE_RE.test(lastErr.message)) {
        // non-load error: still try next, but remember it
      }
      continue;
    }
  }
  throw lastErr ?? new Error('all models failed');
}

const TRIAGE_SYSTEM = `You are a careful triage assistant for a personal markdown todo system.
You will be given a list of open todos from one or more files. For each todo, output an
action recommendation. Output ONLY valid JSON matching the schema, no extra text.

Categories you may use:
- "keep"      — looks current and well-placed
- "archive"   — appears stale, vague, or already implicitly done
- "duplicate" — likely a duplicate of another todo in the input (cite its hash in "duplicate_of")
- "rewrite"   — text is unclear; provide a clearer "suggested_text"
- "move"      — likely belongs under a different heading; provide "suggested_heading"

Be conservative. When uncertain, return "keep". Never invent a hash.`;

const triageUserPrompt = (todos: TriageInput[]): string =>
  `Triage these ${todos.length} todos. Schema:
{ "actions": [ { "hash": "...", "category": "keep|archive|duplicate|rewrite|move",
                 "reason": "short", "duplicate_of": "hash or null",
                 "suggested_text": "string or null",
                 "suggested_heading": "string or null" } ] }

TODOS:
${todos
  .map(
    (t, i) =>
      `${i + 1}. hash=${t.hash} file=${t.relativePath} heading=${t.heading ?? '-'} text=${t.plainText}`,
  )
  .join('\n')}`;

export async function triageTodos(todos: TriageInput[], opts: { model?: string } = {}): Promise<TriageResult> {
  const gen: Parameters<typeof generateWithFallback>[0] = {
    system: TRIAGE_SYSTEM, prompt: triageUserPrompt(todos), format: 'json',
  };
  if (opts.model) gen.preferModel = opts.model;
  const { response, model } = await generateWithFallback(gen);
  try {
    const parsed = JSON.parse(response) as { actions?: TriageResult['actions'] };
    return { actions: parsed.actions ?? [], model };
  } catch {
    return { actions: [], raw: response, model, error: 'invalid JSON from model' };
  }
}

const SUMMARY_SYSTEM = `You produce a concise daily briefing for a person looking at their own todos.
Write in plain prose, 2-4 short paragraphs. Highlight overdue, due-today, and what looks most important.
Do not invent items. Output plain text, no JSON.`;

export async function summarizeDay(
  todos: TodoRowDb[],
  opts: { model?: string; date?: string } = {},
): Promise<SummaryResult> {
  const today = opts.date ?? new Date().toISOString().slice(0, 10);
  const lines = todos
    .map(t => `- [${t.checked ? 'x' : ' '}] ${t.plain_text}  (file: ${t.file_path}; due: ${t.due_date ?? '-'})`)
    .slice(0, 200)
    .join('\n');
  const gen: Parameters<typeof generateWithFallback>[0] = {
    system: SUMMARY_SYSTEM,
    prompt: `Today is ${today}. Here are the open todos:\n${lines}\n\nWrite the briefing.`,
  };
  if (opts.model) gen.preferModel = opts.model;
  const { response, model } = await generateWithFallback(gen);
  return { text: response, model };
}

// ---- extract_todos_from_text ----

const EXTRACT_SYSTEM = `You extract actionable todos from freeform text.
Output ONLY valid JSON. Never invent todos not implied by the input.

Schema: { "todos": [ { "text": "short action phrase", "heading": "section or null", "due": "YYYY-MM-DD or null", "tags": ["tag1"] } ] }

Rules:
- text must be imperative: "Do X" not "X should be done"
- Strip filler words, keep substance
- heading: infer from context (e.g., "Personal", "Work", "Admin")
- due: only if a specific date/deadline is mentioned
- tags: 1-2 lowercase topic tags when obvious`;

interface ExtractedTodo {
  text: string;
  heading: string | null;
  due: string | null;
  tags: string[];
}

export interface ExtractResult {
  todos: ExtractedTodo[];
  model: string;
  error?: string;
}

export async function extractTodosFromText(
  text: string,
  opts: { model?: string } = {},
): Promise<ExtractResult> {
  const gen: Parameters<typeof generateWithFallback>[0] = {
    system: EXTRACT_SYSTEM,
    prompt: `Extract todos from this text:\n\n${text.slice(0, 4000)}`,
    format: 'json',
  };
  if (opts.model) gen.preferModel = opts.model;
  const { response, model } = await generateWithFallback(gen);
  try {
    const parsed = JSON.parse(response) as { todos?: ExtractedTodo[] };
    return { todos: parsed.todos ?? [], model };
  } catch {
    return { todos: [], model, error: 'invalid JSON from model' };
  }
}

// ---- project_rollup ----

const ROLLUP_SYSTEM = `You produce a concise per-section rollup for a planning document.
For each section, write 1-2 sentences: what's blocked, what's in progress, what's done.
Highlight the most important open item per section. Output plain text, no JSON.`;

export interface RollupResult {
  text: string;
  model: string;
}

export async function projectRollup(
  todos: TodoRowDb[],
  opts: { model?: string; title?: string } = {},
): Promise<RollupResult> {
  const byHeading = new Map<string, typeof todos>();
  for (const t of todos) {
    const h = t.heading ?? '(top)';
    if (!byHeading.has(h)) byHeading.set(h, []);
    byHeading.get(h)!.push(t);
  }
  const sections = [...byHeading.entries()]
    .map(([heading, ts]) =>
      `## ${heading}\n` +
      ts.slice(0, 20).map(t => `- [${t.checked ? 'x' : ' '}] ${t.plain_text}${t.due_date ? ` (due: ${t.due_date})` : ''}`).join('\n'),
    )
    .join('\n\n');

  const gen: Parameters<typeof generateWithFallback>[0] = {
    system: ROLLUP_SYSTEM,
    prompt: `${opts.title ? `File: ${opts.title}\n\n` : ''}${sections}`,
  };
  if (opts.model) gen.preferModel = opts.model;
  const { response, model } = await generateWithFallback(gen);
  return { text: response, model };
}

// ---- propose_archive ----

const ARCHIVE_SYSTEM = `You review open todos and identify candidates to archive.
Archive = stale, completed by implication, superseded, or no longer relevant.
Be conservative — mark "archive" only when confident.
Output ONLY valid JSON.

Schema: { "proposals": [ { "hash": "...", "reason": "short explanation" } ] }`;

export interface ArchiveProposal {
  hash: string;
  reason: string;
}

export interface ArchiveResult {
  proposals: ArchiveProposal[];
  model: string;
  error?: string;
}

export async function proposeArchive(
  todos: TriageInput[],
  opts: { model?: string } = {},
): Promise<ArchiveResult> {
  const lines = todos
    .slice(0, 100)
    .map((t, i) => `${i + 1}. hash=${t.hash} heading=${t.heading ?? '-'} text=${t.plainText}`)
    .join('\n');
  const gen: Parameters<typeof generateWithFallback>[0] = {
    system: ARCHIVE_SYSTEM,
    prompt: `Review these ${todos.length} open todos and identify archive candidates:\n${lines}`,
    format: 'json',
  };
  if (opts.model) gen.preferModel = opts.model;
  const { response, model } = await generateWithFallback(gen);
  try {
    const parsed = JSON.parse(response) as { proposals?: ArchiveProposal[] };
    return { proposals: parsed.proposals ?? [], model };
  } catch {
    return { proposals: [], model, error: 'invalid JSON from model' };
  }
}

function pickModel(available: string[]): string {
  const order = [
    'qwen3.6:35b',
    'nemotron3:33b',
    'gemma4:31b',
    'qwen2.5:7b-instruct',
    'qwen2.5:7b',
    'llama3.2:3b',
    'qwen2.5:3b',
    'phi4:mini',
    'qwen2.5:1.5b',
    'qwen2.5:0.5b',
  ];
  for (const m of order) {
    const hit = available.find(a => a === m || a.startsWith(m + ':') || a.startsWith(m));
    if (hit) return hit;
  }
  return available[0] ?? 'qwen2.5:0.5b';
}

/** Exported alias so other modules (summary.ts) can reuse model selection. */
export function pickModelExport(available: string[]): string {
  return pickModel(available);
}
