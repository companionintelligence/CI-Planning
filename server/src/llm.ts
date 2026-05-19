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
  if (!(await ollamaAvailable())) throw new LLMUnavailable();
  const models = await listModels();
  const chosen = opts.model ?? pickModel(models);
  const res = await generate({
    model: chosen,
    system: TRIAGE_SYSTEM,
    prompt: triageUserPrompt(todos),
    format: 'json',
  });
  try {
    const parsed = JSON.parse(res.response) as { actions?: TriageResult['actions'] };
    return { actions: parsed.actions ?? [], model: chosen };
  } catch {
    return { actions: [], raw: res.response, model: chosen, error: 'invalid JSON from model' };
  }
}

const SUMMARY_SYSTEM = `You produce a concise daily briefing for a person looking at their own todos.
Write in plain prose, 2-4 short paragraphs. Highlight overdue, due-today, and what looks most important.
Do not invent items. Output plain text, no JSON.`;

export async function summarizeDay(
  todos: TodoRowDb[],
  opts: { model?: string; date?: string } = {},
): Promise<SummaryResult> {
  if (!(await ollamaAvailable())) throw new LLMUnavailable();
  const models = await listModels();
  const chosen = opts.model ?? pickModel(models);
  const today = opts.date ?? new Date().toISOString().slice(0, 10);
  const lines = todos
    .map(t => `- [${t.checked ? 'x' : ' '}] ${t.plain_text}  (file: ${t.file_path}; due: ${t.due_date ?? '-'})`)
    .slice(0, 200)
    .join('\n');
  const res = await generate({
    model: chosen,
    system: SUMMARY_SYSTEM,
    prompt: `Today is ${today}. Here are the open todos:\n${lines}\n\nWrite the briefing.`,
  });
  return { text: res.response, model: chosen };
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
