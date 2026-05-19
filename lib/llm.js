// Thin Ollama HTTP client. Graceful no-op if Ollama is not running.

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

export class LLMUnavailable extends Error {}

export async function ollamaAvailable(host = DEFAULT_HOST) {
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function listModels(host = DEFAULT_HOST) {
  const r = await fetch(`${host}/api/tags`);
  if (!r.ok) throw new LLMUnavailable('ollama not reachable');
  const j = await r.json();
  return (j.models || []).map(m => m.name);
}

export async function generate({
  model,
  prompt,
  system,
  format,
  options,
  host = DEFAULT_HOST,
  timeoutMs = 120000,
}) {
  const body = {
    model,
    prompt,
    system,
    stream: false,
    options: { temperature: 0.2, ...(options || {}) },
  };
  if (format) body.format = format;
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
  return r.json();
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

const TRIAGE_USER = (todos) => `Triage these ${todos.length} todos. Schema:
{ "actions": [ { "hash": "...", "category": "keep|archive|duplicate|rewrite|move",
                 "reason": "short", "duplicate_of": "hash or null",
                 "suggested_text": "string or null",
                 "suggested_heading": "string or null" } ] }

TODOS:
${todos
  .map(
    (t, i) =>
      `${i + 1}. hash=${t.hash} file=${t.relativePath || t.file_path} heading=${t.heading || '-'} text=${t.plain_text || t.plainText}`
  )
  .join('\n')}`;

export async function triageTodos(todos, { model } = {}) {
  if (!(await ollamaAvailable())) throw new LLMUnavailable();
  const models = await listModels();
  const chosen = model || pickModel(models);
  const res = await generate({
    model: chosen,
    system: TRIAGE_SYSTEM,
    prompt: TRIAGE_USER(todos),
    format: 'json',
  });
  let parsed;
  try {
    parsed = JSON.parse(res.response);
  } catch {
    return { actions: [], raw: res.response, model: chosen, error: 'invalid JSON from model' };
  }
  return { ...parsed, model: chosen };
}

const SUMMARY_SYSTEM = `You produce a concise daily briefing for a person looking at their own todos.
Write in plain prose, 2-4 short paragraphs. Highlight overdue, due-today, and what looks most important.
Do not invent items. Output plain text, no JSON.`;

export async function summarizeDay(todos, { model, date } = {}) {
  if (!(await ollamaAvailable())) throw new LLMUnavailable();
  const models = await listModels();
  const chosen = model || pickModel(models);
  const today = date || new Date().toISOString().slice(0, 10);
  const lines = todos
    .map(t => `- [${t.checked ? 'x' : ' '}] ${t.plain_text || t.plainText}  (file: ${t.relativePath || t.file_path}; due: ${t.due_date || '-'})`)
    .slice(0, 200)
    .join('\n');
  const res = await generate({
    model: chosen,
    system: SUMMARY_SYSTEM,
    prompt: `Today is ${today}. Here are the open todos:\n${lines}\n\nWrite the briefing.`,
  });
  return { text: res.response, model: chosen };
}

function pickModel(available) {
  // Preference order: best-reasoning instruction models first.
  // The big models (20-30B) handle triage / dedupe / summary far better than 7B.
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
  return available[0];
}
