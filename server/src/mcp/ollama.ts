import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import {
  resolveModel,
  resolveEmbedModel,
  explainModel,
  explainEmbedModel,
  explainModelDefault,
  explainEmbedModelDefault,
  generationSelectionWarnings,
  setInstalledModels,
  isInstalled,
  parseParamB,
  type InstalledModel,
  type ModelSource,
} from '../lib/models.js';

/** Thrown when Ollama is unreachable or a model isn't available. Callers may catch and degrade. */
export class OllamaUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaUnavailable';
  }
}

export type ModelTier = 'small' | 'medium';

function modelFor(tier: ModelTier): string {
  return resolveModel(tier); // per-owner Settings override, else env default
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

/**
 * Build an OllamaUnavailable for a non-OK response. A missing model is detected by
 * Ollama's body ("model '...' not found, try pulling it first"), NOT by the 404 status
 * alone — a bare 404 can also mean a wrong OLLAMA_URL, an API-path mismatch, or a proxy.
 * So we only give the pull/override hint when the body confirms it, and otherwise return
 * a generic error that names the endpoint (to surface URL problems) with a trimmed body.
 */
async function ollamaError(op: string, res: Response, model: string): Promise<OllamaUnavailable> {
  const bodyTrimmed = (await res.text().catch(() => '')).trim();
  const bodySnippet = bodyTrimmed.length > 500 ? `${bodyTrimmed.slice(0, 500)}…` : bodyTrimmed;

  // 404 *usually* means the model isn't pulled, but avoid misdiagnosing endpoint/proxy 404s.
  if (res.status === 404 && /model\s+['"].+['"]\s+not\s+found/i.test(bodyTrimmed)) {
    return new OllamaUnavailable(
      `Model '${model}' is not installed in Ollama. Run \`ollama pull ${model}\`, or set ` +
        `OLLAMA_SMALL / OLLAMA_MEDIUM / OLLAMA_EMBED in server/.env to a model from \`ollama list\`.`,
    );
  }
  // Name the endpoint so a wrong OLLAMA_URL / proxy 404 is diagnosable from the message.
  return new OllamaUnavailable(
    `Ollama ${op} failed at ${config.ollamaUrl}: ${res.status}${bodySnippet ? ` ${bodySnippet}` : ''}`,
  );
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

  if (!res.ok) throw await ollamaError('generate', res, model);
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
  const model = resolveEmbedModel();
  const res = await fetchWithTimeout(
    `${config.ollamaUrl}/api/embeddings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    },
    timeoutMs
  );
  if (!res.ok) throw await ollamaError('embeddings', res, model);
  const data = (await res.json()) as { embedding?: number[] };
  if (!data.embedding?.length) throw new OllamaUnavailable('Ollama returned an empty embedding');
  return data.embedding;
}

export interface OllamaStatus {
  /** Ollama answered `/api/tags`. Says NOTHING about whether a usable model is pulled. */
  available: boolean;
  /**
   * Reachable AND the models that would actually be used are installed. This is the
   * signal AI features gate on: `available` alone was reported as a green light while
   * every call failed with `model '…' not found`, because the built-in default tags
   * aren't pulled on most machines.
   */
  ready: boolean;
  url: string;
  models: string[];
  /** The EFFECTIVE models for this owner (Settings override → env pin → auto-selected),
   *  not the raw built-in defaults — those were what made the old display misleading. */
  smallModel: string;
  mediumModel: string;
  embedModel: string;
  /** Effective models that are NOT installed, so the UI can name them. */
  missingModels: string[];
  /**
   * How each effective model was chosen. `auto` means nothing was pinned or picked and
   * the app guessed from what is installed — worth showing, because an auto-selected name
   * otherwise looks identical to a deliberate one in the UI.
   */
  modelSources: { small: ModelSource; medium: ModelSource; embed: ModelSource };
  /** Cautions about auto-selected picks (e.g. no tool-use capability). Empty when fine. */
  modelWarnings: string[];
  error?: string;
}

/**
 * Health check + installed model list. Never throws.
 *
 * Also the single place that refreshes the installed-model cache `lib/models.ts` uses to
 * auto-select a real model — `resolveModel` is synchronous and on the inference hot path,
 * so it can't fetch `/api/tags` itself. Called at boot, by the Settings/integrations poll,
 * and by "Re-check".
 *
 * `owner` is optional because this runs outside a request too (boot, tests), where
 * `currentOwnerId()` throws by design; without one, per-owner Settings overrides are
 * skipped and the env/auto-selected models are reported.
 */
export async function status(owner?: string): Promise<OllamaStatus> {
  /** Effective models — resolved AFTER the cache refresh so auto-selection is applied. */
  const effective = () => {
    // No owner context (boot health logging): drop only the per-owner override and still
    // apply env-pin → installed-default → auto-selection. Returning the raw configured
    // names here would report `qwen2.5:0.5b` as effective while every request actually
    // used the auto-selected model.
    let small, medium, embed;
    try {
      small = explainModel('small', owner);
      medium = explainModel('medium', owner);
      embed = explainEmbedModel(owner);
    } catch {
      small = explainModelDefault('small');
      medium = explainModelDefault('medium');
      embed = explainEmbedModelDefault();
    }
    return {
      smallModel: small.name,
      mediumModel: medium.name,
      embedModel: embed.name,
      modelSources: { small: small.source, medium: medium.source, embed: embed.source },
      modelWarnings: generationSelectionWarnings([
        { tier: 'small' as const, model: small },
        { tier: 'medium' as const, model: medium },
      ]),
    };
  };

  try {
    const res = await fetchWithTimeout(`${config.ollamaUrl}/api/tags`, {}, 5_000);
    if (!res.ok) {
      setInstalledModels(null); // unknown, not "none" — don't auto-select off a bad read
      return { ...effective(), url: config.ollamaUrl, available: false, ready: false, models: [], missingModels: [], error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      models?: { name: string; capabilities?: string[]; details?: { parameter_size?: string } }[];
    };
    const rows: InstalledModel[] = (data.models ?? []).map((m) => ({
      name: m.name,
      capabilities: m.capabilities ?? [],
      paramB: parseParamB(m.details?.parameter_size),
    }));
    // Never auto-select during tests. Otherwise the suite's behavior depends on whether
    // the developer happens to be running Ollama: with it up, auto-selection hands every
    // agent a REAL model, so jobs/enrichment stop failing fast on "model not found" and
    // instead perform genuine inference — run-now alone went from ~1s to 124s, and the
    // parallel suite then times out. Tests that exercise selection set the cache directly
    // via setInstalledModels(); leaving it unknown here keeps every other suite on the
    // deterministic degrade path it was written against.
    if (process.env.NODE_ENV !== 'test') setInstalledModels(rows);

    const eff = effective();
    // The embed tier is only exercised by dedupe/memory, so a missing embedder is
    // reported but does not by itself make the app "not ready" for AI features.
    const missingModels = [eff.smallModel, eff.mediumModel, eff.embedModel].filter((m) => !isInstalled(m));
    return {
      ...eff,
      url: config.ollamaUrl,
      available: true,
      ready: isInstalled(eff.smallModel) && isInstalled(eff.mediumModel),
      models: rows.map((m) => m.name),
      missingModels,
    };
  } catch (err) {
    setInstalledModels(null);
    return { ...effective(), url: config.ollamaUrl, available: false, ready: false, models: [], missingModels: [], error: (err as Error).message };
  }
}

/** Convenience: is Ollama reachable right now? Used by tests to skip gracefully. */
export async function isAvailable(): Promise<boolean> {
  return (await status()).available;
}

export const ollama = { generate, generateJson, parseJsonLoose, embed, status, isAvailable };
logger.debug('ollama client ready', { url: config.ollamaUrl });
