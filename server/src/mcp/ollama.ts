import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

/** Thrown when Ollama is unreachable or a model isn't available. Callers may catch and degrade. */
export class OllamaUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaUnavailable';
  }
}

export type ModelTier = 'small' | 'medium';

function modelFor(tier: ModelTier): string {
  return tier === 'medium' ? config.ollamaMediumModel : config.ollamaSmallModel;
}

interface GenerateOpts {
  tier?: ModelTier;
  model?: string;
  /** Force structured JSON output. */
  json?: boolean;
  system?: string;
  temperature?: number;
  /** Abort if the request takes longer than this (ms). */
  timeoutMs?: number;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new OllamaUnavailable(`Ollama request timed out after ${timeoutMs}ms`);
    }
    throw new OllamaUnavailable(`Ollama unreachable at ${config.ollamaUrl}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Low-level text generation. Returns the raw completion string. */
export async function generate(prompt: string, opts: GenerateOpts = {}): Promise<string> {
  const model = opts.model ?? modelFor(opts.tier ?? 'small');
  const body = {
    model,
    prompt,
    stream: false,
    ...(opts.json ? { format: 'json' } : {}),
    ...(opts.system ? { system: opts.system } : {}),
    options: { temperature: opts.temperature ?? 0.2 },
  };

  const res = await fetchWithTimeout(
    `${config.ollamaUrl}/api/generate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    opts.timeoutMs ?? 60_000
  );

  if (!res.ok) throw new OllamaUnavailable(`Ollama generate failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { response?: string };
  return data.response ?? '';
}

/**
 * Generate and parse a JSON object. Tolerates models that wrap JSON in prose or fences.
 * Throws OllamaUnavailable on transport failure; throws a plain Error if no JSON can be parsed.
 */
export async function generateJson<T = unknown>(prompt: string, opts: GenerateOpts = {}): Promise<T> {
  const raw = await generate(prompt, { ...opts, json: true });
  return parseJsonLoose<T>(raw);
}

/** Best-effort JSON extraction from a model response. */
export function parseJsonLoose<T = unknown>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Strip ```json fences and grab the first {...} or [...] span.
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
    const match = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error(`Could not parse JSON from model output: ${raw.slice(0, 200)}`);
  }
}

/** Return an embedding vector for a single piece of text. */
export async function embed(text: string, timeoutMs = 30_000): Promise<number[]> {
  const res = await fetchWithTimeout(
    `${config.ollamaUrl}/api/embeddings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.ollamaEmbedModel, prompt: text }),
    },
    timeoutMs
  );
  if (!res.ok) throw new OllamaUnavailable(`Ollama embeddings failed: ${res.status}`);
  const data = (await res.json()) as { embedding?: number[] };
  if (!data.embedding?.length) throw new OllamaUnavailable('Ollama returned an empty embedding');
  return data.embedding;
}

export interface OllamaStatus {
  available: boolean;
  url: string;
  models: string[];
  smallModel: string;
  mediumModel: string;
  embedModel: string;
  error?: string;
}

/** Health check + installed model list. Never throws. */
export async function status(): Promise<OllamaStatus> {
  const base: Omit<OllamaStatus, 'available' | 'models' | 'error'> = {
    url: config.ollamaUrl,
    smallModel: config.ollamaSmallModel,
    mediumModel: config.ollamaMediumModel,
    embedModel: config.ollamaEmbedModel,
  };
  try {
    const res = await fetchWithTimeout(`${config.ollamaUrl}/api/tags`, {}, 5_000);
    if (!res.ok) return { ...base, available: false, models: [], error: `HTTP ${res.status}` };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { ...base, available: true, models: (data.models ?? []).map((m) => m.name) };
  } catch (err) {
    return { ...base, available: false, models: [], error: (err as Error).message };
  }
}

/** Convenience: is Ollama reachable right now? Used by tests to skip gracefully. */
export async function isAvailable(): Promise<boolean> {
  return (await status()).available;
}

export const ollama = { generate, generateJson, parseJsonLoose, embed, status, isAvailable };
logger.debug('ollama client ready', { url: config.ollamaUrl });
