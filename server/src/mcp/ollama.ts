import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { ConnectorUnavailable } from '../lib/connector-error.js';
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
export class OllamaUnavailable extends ConnectorUnavailable {
  constructor(message: string) {
    super('ollama', message);
    this.name = 'OllamaUnavailable';
  }
}

export type ModelTier = 'fast' | 'quality';

async function modelFor(tier: ModelTier): Promise<string> {
  return await resolveModel(tier); // per-owner Settings override, else env default
}

/** The three numbers every call needs. One row of {@link CALL_POLICY}. */
export interface CallPolicy {
  tier: ModelTier;
  temperature: number;
  timeoutMs: number;
}

/**
 * Named call policies — the ONE place LLM call parameters live.
 *
 * A call site names a *purpose*; it never re-types the numbers. Before this table the
 * same triple was hand-rolled at 16 sites, so nothing distinguished a deliberate
 * difference from copy-paste drift, and "raise every classifier timeout" meant grepping.
 *
 * These are CODE constants, not configuration. Each was measured against a live model
 * (see the re-testing note in `agents/rubric.ts`), so they move under a measured retune,
 * never via an env var. Every entry states WHY its numbers are what they are; changing
 * one changes what a model receives at every site that names it.
 *
 * Explicit `tier` / `temperature` / `timeoutMs` on a call still win over the purpose, so
 * a one-off (render-copy's per-surface timeout, extract's caller budget) needs no new
 * machinery.
 */
export const CALL_POLICY = {
  /** Pick from a closed list: near-greedy so a 3B stays on the allowlist instead of
   *  inventing; 15s because a user is watching the quick-add spinner. */
  classify: { tier: 'fast', temperature: 0.1, timeoutMs: 15_000 },
  /** Same job, but the answer includes free-text the model must compose, so it gets a
   *  little room (0.2) and a longer ceiling for the bigger prompt. */
  classify_wide: { tier: 'fast', temperature: 0.2, timeoutMs: 20_000 },
  /** Invent plausible steps — needs variety, and the merge/allowlist catches the misses. */
  brainstorm: { tier: 'fast', temperature: 0.3, timeoutMs: 20_000 },
  /** Read a whole source item and enumerate tasks: quality tier for recall, near-greedy
   *  so nothing is invented, and a full minute because the input can be long. */
  extract: { tier: 'quality', temperature: 0.1, timeoutMs: 60_000 },
  /** §A0 generator (order + revise). Fast tier ON PURPOSE — the generator must not be the
   *  judge (see `plan_judge`). 0.2 gives the loop something to revise. */
  plan_generate: { tier: 'fast', temperature: 0.2, timeoutMs: 25_000 },
  /** §A0 judge. Quality tier ON PURPOSE, and kept a SEPARATE entry from `plan_generate`
   *  even where values would coincide: the loop's "generator ≠ evaluator" guarantee is
   *  expressed as this tier split, so the model grading an order is never the model that
   *  produced it. Near-greedy so a re-judge of the same order scores it the same way. */
  plan_judge: { tier: 'quality', temperature: 0.1, timeoutMs: 30_000 },
  /** One "why now" line per task. Prose for a human, so warmer than a classifier; still
   *  fast tier because it is a batch call on the plan's hot path. */
  plan_narrate: { tier: 'fast', temperature: 0.3, timeoutMs: 25_000 },
  /** Parse a natural-language planning instruction into pins. Near-greedy: the same
   *  sentence must yield the same edit, because the caller then writes it. */
  plan_instruct: { tier: 'fast', temperature: 0.1, timeoutMs: 25_000 },
  /** Background suggestion pass over a batch — nobody is waiting, so it gets 30s. */
  suggest: { tier: 'fast', temperature: 0.2, timeoutMs: 30_000 },
  /** Long-form prose a person reads end to end: quality tier, and the warmest setting
   *  that still tracks the facts it was given. */
  narrate: { tier: 'quality', temperature: 0.4, timeoutMs: 60_000 },
  /** Microcopy. High temperature wants variety; the model-free gate enforces the floor,
   *  so a bad draft costs a regenerate, not a bad line. Tier and timeout are per-surface
   *  and passed explicitly by `render-copy.ts`; this row carries the fast-tier pair. */
  voice: { tier: 'fast', temperature: 0.7, timeoutMs: 15_000 },
} as const satisfies Record<string, CallPolicy>;

/** The name a call site uses instead of numbers. */
export type CallPurpose = keyof typeof CALL_POLICY;

interface GenerateOpts {
  /** Name a row of {@link CALL_POLICY} instead of re-typing tier/temperature/timeout. */
  purpose?: CallPurpose;
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
 * Fold a purpose into the three numbers a request needs. An explicitly passed value
 * always wins over the purpose's; with neither, the historical bare-`generate()`
 * defaults apply so an un-named call behaves exactly as before.
 *
 * Exported so the policy table can be asserted directly (`test/llm-call-policy.test.ts`)
 * without standing up a fake Ollama.
 */
export function resolveCall(opts: { purpose?: CallPurpose; tier?: ModelTier; temperature?: number; timeoutMs?: number } = {}): CallPolicy {
  const policy: CallPolicy | undefined = opts.purpose ? CALL_POLICY[opts.purpose] : undefined;
  return {
    tier: opts.tier ?? policy?.tier ?? 'fast',
    temperature: opts.temperature ?? policy?.temperature ?? 0.2,
    timeoutMs: opts.timeoutMs ?? policy?.timeoutMs ?? 60_000,
  };
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
        `OLLAMA_FAST / OLLAMA_QUALITY / OLLAMA_EMBED in server/.env to a model from \`ollama list\`.`,
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
  const call = resolveCall(opts);
  const model = opts.model ?? (await modelFor(call.tier));
  const body = {
    model,
    prompt,
    stream: false,
    ...(opts.json ? { format: 'json' } : {}),
    ...(opts.system ? { system: opts.system } : {}),
    options: { temperature: call.temperature },
  };

  const res = await fetchWithTimeout(
    `${config.ollamaUrl}/api/generate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    call.timeoutMs
  );

  if (!res.ok) throw await ollamaError('generate', res, model);
  const data = await decodeJson<{ response?: string }>(res, 'generate');
  return data.response ?? '';
}

/**
 * Decode a 200 response body as JSON, as OllamaUnavailable when it isn't.
 *
 * A 200 whose body is not JSON means whatever answered is not speaking Ollama's protocol —
 * a proxy or tunnel returning an HTML error page, a truncated body, an API-path mismatch.
 * That is a TRANSPORT failure and belongs in the same family as the non-OK path above
 * (see ollamaError's note that a bare 404 can equally mean a wrong OLLAMA_URL or a proxy).
 *
 * Typing it that way is load-bearing for the degrade contract: `llmOrNull` degrades on
 * OllamaUnavailable and LlmParseError and RE-THROWS everything else, so a raw SyntaxError
 * escaping from here would turn what used to be a silent, correct degrade (suggestTags → [],
 * subtasks → []) into a 500. It is NOT LlmParseError — that one means the model's own reply
 * wasn't the JSON we asked for, which is a model problem, not a transport one.
 */
async function decodeJson<T>(res: Response, op: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new OllamaUnavailable(
      `Ollama ${op} returned a non-JSON body from ${config.ollamaUrl} — check OLLAMA_URL and any proxy in front of it: ${(err as Error).message}`,
    );
  }
}

/**
 * Generate and parse a JSON object. Tolerates models that wrap JSON in prose or fences.
 * Throws OllamaUnavailable on transport failure; throws LlmParseError if no JSON can be parsed.
 */
export async function generateJson<T = unknown>(prompt: string, opts: GenerateOpts = {}): Promise<T> {
  const raw = await generate(prompt, { ...opts, json: true });
  return parseJsonLoose<T>(raw);
}

/**
 * THE degrade contract for every best-effort LLM path.
 *
 * Run `fn`; return `null` for the two failures a caller can do nothing about — Ollama
 * unreachable/timed out/model not pulled ({@link OllamaUnavailable}) and a reply that is
 * not JSON ({@link LlmParseError}) — logging one `warn` naming `op`. **Anything else
 * re-throws**: a `TypeError` in a caller's own callback is a bug, and six hand-rolled
 * `catch {}` blocks used to swallow it into an empty result that looked like "the model
 * had nothing to say".
 *
 * NOT for `runLoop` stage callbacks (`agents/loop.ts`). The loop's error contract is that
 * a generator/judge transport failure propagates OUT to the authoring caller, which falls
 * back to the deterministic baseline; a `null` returned INTO the loop would flow through
 * `check()`/`judge()` as a candidate and silently break the stall→baseline escape hatch
 * and the call-budget accounting. The loop and its caller ARE the handler there.
 *
 * Callers owing the user a *reason* (task-enrich's `reason` string, `parseInstruction`'s
 * 503) keep their own branch on the `null` — but never a bare `catch {}`.
 */
export async function llmOrNull<T>(op: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OllamaUnavailable || err instanceof LlmParseError) {
      logger.warn('llm degraded', { op, err: (err as Error).message });
      return null;
    }
    throw err;
  }
}

/**
 * Thrown when a model reply cannot be parsed as JSON. Distinct from a caller bug, so
 * {@link llmOrNull} can degrade on it without swallowing real errors. Still an `Error`,
 * so the broad catches that predate this class are unaffected.
 */
export class LlmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmParseError';
  }
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
    throw new LlmParseError(`Could not parse JSON from model output: ${raw.slice(0, 200)}`);
  }
}

/** Return an embedding vector for a single piece of text. */
export async function embed(text: string, timeoutMs = 30_000): Promise<number[]> {
  const model = await resolveEmbedModel();
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
  const data = await decodeJson<{ embedding?: number[] }>(res, 'embeddings');
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
  fastModel: string;
  qualityModel: string;
  embedModel: string;
  /** Effective models that are NOT installed, so the UI can name them. */
  missingModels: string[];
  /**
   * How each effective model was chosen. `auto` means nothing was pinned or picked and
   * the app guessed from what is installed — worth showing, because an auto-selected name
   * otherwise looks identical to a deliberate one in the UI.
   */
  modelSources: { fast: ModelSource; quality: ModelSource; embed: ModelSource };
  /** Cautions about auto-selected picks (e.g. no tool-use capability). Empty when fine. */
  modelWarnings: string[];
  error?: string;
}

/**
 * The `/api/tags` half of a status read: did Ollama answer, and with what.
 *
 * Deliberately NOT the resolved models — see {@link status} for why those are never
 * cached alongside this.
 */
interface TagsProbe {
  ok: boolean;
  rows: InstalledModel[];
  error?: string;
}

/**
 * How long one `/api/tags` probe stands in for the next.
 *
 * A CODE constant, not configuration — there is nothing here an operator tunes. It only
 * has to be shorter than the Settings poll and longer than a plan render, and the one
 * case a TTL cannot cover (an Ollama that came up seconds ago) has an explicit escape
 * hatch: "Re-check" → `/api/llm/status?fresh=1` → `status(owner, { fresh: true })`.
 */
const PROBE_TTL_MS = 30_000;

let probeCache: { at: number; probe: TagsProbe } | null = null;

/** Drop the cached probe. For tests — production bypasses with `{ fresh: true }`. */
export function resetProbeCache(): void {
  probeCache = null;
  // Drop any joined probe too, or a test could inherit the previous one's in-flight request.
  probeInFlight = null;
  // …and the issue-order counters, or a test's first probe could be judged "late" against a
  // sequence left behind by the previous one and silently decline to write the cache.
  probeSeq = 0;
  lastAppliedSeq = 0;
}

/** Feed a probe result to the installed-model cache `lib/models.ts` auto-selects from. */
function applyInstalled(probe: TagsProbe): void {
  // A failed read is "unknown", not "none" — don't auto-select off a bad read.
  if (!probe.ok) return setInstalledModels(null);
  // Never auto-select during tests. Otherwise the suite's behavior depends on whether
  // the developer happens to be running Ollama: with it up, auto-selection hands every
  // agent a REAL model, so jobs/enrichment stop failing fast on "model not found" and
  // instead perform genuine inference — run-now alone went from ~1s to 124s, and the
  // parallel suite then times out. Tests that exercise selection set the cache directly
  // via setInstalledModels(); leaving it unknown here keeps every other suite on the
  // deterministic degrade path it was written against.
  if (process.env.NODE_ENV !== 'test') setInstalledModels(probe.rows);
}

/** One live `/api/tags` read. Never throws — a failure IS a result (`ok: false`). */
async function fetchTags(): Promise<TagsProbe> {
  try {
    const res = await fetchWithTimeout(`${config.ollamaUrl}/api/tags`, {}, 5_000);
    if (!res.ok) return { ok: false, rows: [], error: `HTTP ${res.status}` };
    const data = (await res.json()) as {
      models?: { name: string; capabilities?: string[]; details?: { parameter_size?: string } }[];
    };
    return {
      ok: true,
      rows: (data.models ?? []).map((m) => ({
        name: m.name,
        capabilities: m.capabilities ?? [],
        paramB: parseParamB(m.details?.parameter_size),
      })),
    };
  } catch (err) {
    return { ok: false, rows: [], error: (err as Error).message };
  }
}

/**
 * A probe already in flight, so concurrent callers share one `/api/tags` request instead of
 * racing to issue their own. The TTL alone does not cover this: it only helps once a probe has
 * COMPLETED, and the window before that is exactly when callers pile up — boot, the Settings
 * poll, and `isReady()` on the day-authoring and NL-instruct paths can all land on a cold
 * cache together.
 *
 * Clearing this in a `finally` only ends the JOIN — it does NOT make a failed reading
 * transient. `fetchTags()` never throws; an unreachable Ollama comes back as `{ ok: false }`
 * and is cached like any other reading, deliberately, so a down Ollama is not re-probed once
 * per authoring call. `fresh: true` is the bypass for that (see `resetProbeCache` and the
 * "failed probe is cached like any other" case in `ollama.test.ts`).
 */
let probeInFlight: Promise<TagsProbe> | null = null;

/**
 * Issue order for probes, so a slower EARLIER probe cannot overwrite a faster LATER one.
 *
 * Without this, `fresh` defeats itself: a non-fresh probe already in flight and a concurrent
 * `fresh: true` probe both write the cache unconditionally, so if the older request lands
 * second it replaces the Re-check reading with a staler one — under a NEWER timestamp, which
 * then serves every caller for the rest of the TTL. Only the highest-numbered probe to
 * complete may write `probeCache` or touch the installed-model cache.
 */
let probeSeq = 0;
let lastAppliedSeq = 0;

/** The probe, from cache when it is fresh enough and not bypassed. */
async function tagsProbe(fresh: boolean): Promise<TagsProbe> {
  // The cache is OFF under test, for the same reason as the auto-select guard in
  // applyInstalled(): no suite's behavior may depend on which test probed first.
  const cacheable = process.env.NODE_ENV !== 'test';
  if (cacheable && !fresh && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
    applyInstalled(probeCache.probe); // keep lib/models in step even on a hit
    return probeCache.probe;
  }
  // Join an in-flight probe rather than starting a second one. `fresh` deliberately does NOT
  // join: "Re-check" means the caller wants a reading taken after they asked, and a probe
  // already in flight may have been issued before.
  if (cacheable && !fresh && probeInFlight) return probeInFlight;

  const seq = ++probeSeq;
  const run = (async () => {
    const probe = await fetchTags();
    // Late arrival from an earlier request: hand this caller its own answer, but do not let
    // it clobber a newer reading that already landed.
    if (seq >= lastAppliedSeq) {
      lastAppliedSeq = seq;
      applyInstalled(probe);
      probeCache = cacheable ? { at: Date.now(), probe } : null;
    }
    return probe;
  })();
  if (cacheable && !fresh) probeInFlight = run;
  try {
    return await run;
  } finally {
    if (probeInFlight === run) probeInFlight = null;
  }
}

/**
 * Health check + installed model list. Never throws.
 *
 * Also the single place that refreshes the installed-model cache `lib/models.ts` uses to
 * auto-select a real model — `resolveModel` is synchronous and on the inference hot path,
 * so it can't fetch `/api/tags` itself. Called at boot, by the Settings/integrations poll,
 * by "Re-check", and — via `isReady()` — on the day-authoring and NL-instruct paths.
 *
 * ONLY the `/api/tags` probe is cached (`PROBE_TTL_MS`); model resolution is redone on
 * every call. That split is load-bearing, not an optimization detail: a Settings model
 * override is a DB write that must take effect on the very NEXT request, so caching the
 * resolved names would make a saved model choice look like it did not apply.
 *
 * `owner` is optional because this runs outside a request too (boot, tests), where
 * `currentOwnerId()` throws by design; without one, per-owner Settings overrides are
 * skipped and the env/auto-selected models are reported.
 *
 * `fresh` bypasses the probe cache and refills it — the "Re-check" path.
 */
export async function status(owner?: string, opts?: { fresh?: boolean }): Promise<OllamaStatus> {
  /** Effective models — resolved AFTER the cache refresh so auto-selection is applied. */
  const effective = async () => {
    // No owner context (boot health logging): drop only the per-owner override and still
    // apply env-pin → installed-default → auto-selection. Returning the raw configured
    // names here would report `qwen2.5:0.5b` as effective while every request actually
    // used the auto-selected model.
    let fast, quality, embed;
    try {
      fast = await explainModel('fast', owner);
      quality = await explainModel('quality', owner);
      embed = await explainEmbedModel(owner);
    } catch {
      fast = explainModelDefault('fast');
      quality = explainModelDefault('quality');
      embed = explainEmbedModelDefault();
    }
    return {
      fastModel: fast.name,
      qualityModel: quality.name,
      embedModel: embed.name,
      modelSources: { fast: fast.source, quality: quality.source, embed: embed.source },
      modelWarnings: generationSelectionWarnings([
        { tier: 'fast' as const, model: fast },
        { tier: 'quality' as const, model: quality },
      ]),
    };
  };

  const probe = await tagsProbe(opts?.fresh === true);
  // Resolved AFTER the probe was applied (so auto-selection sees the installed set) and
  // on EVERY call, cache hit or not — this is the per-owner override read.
  const eff = await effective();
  if (!probe.ok) {
    return { ...eff, url: config.ollamaUrl, available: false, ready: false, models: [], missingModels: [], error: probe.error };
  }
  // The embed tier is only exercised by dedupe/memory, so a missing embedder is
  // reported but does not by itself make the app "not ready" for AI features.
  const missingModels = [eff.fastModel, eff.qualityModel, eff.embedModel].filter((m) => !isInstalled(m));
  return {
    ...eff,
    url: config.ollamaUrl,
    available: true,
    ready: isInstalled(eff.fastModel) && isInstalled(eff.qualityModel),
    models: probe.rows.map((m) => m.name),
    missingModels,
  };
}

/**
 * THE availability predicate: can we actually call a model right now?
 *
 * `ready`, NOT `available`. `available` only means Ollama answered `/api/tags` — a green
 * light with nothing behind it, since the effective models may not be pulled. Gating on
 * it ran whole LLM paths against an Ollama that could not serve one call. The client
 * (`stores/index.ts`) and the Settings card already mean `ready` by "AI is on"; this is
 * the server saying the same thing. `status().available` stays on the status object for
 * the Settings card, which legitimately shows reachable-vs-usable as distinct states.
 */
export async function isReady(): Promise<boolean> {
  return (await status()).ready;
}

export const ollama = { generate, generateJson, llmOrNull, parseJsonLoose, embed, status, isReady };
logger.debug('ollama client ready', { url: config.ollamaUrl });
