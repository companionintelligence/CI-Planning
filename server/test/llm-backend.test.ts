import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config, llmBackendFromEnv, ollamaModelsFromEnv, openAiCompatFromEnv } from '../src/lib/config.js';
import { status, generate, embed, resetProbeCache, OllamaUnavailable } from '../src/mcp/ollama.js';
import { setInstalledModels } from '../src/lib/models.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * The CI-Hub hands Planning an OpenAI-compatible endpoint (vLLM, Lemonade, the Hub's own
 * `/api/inference/v1`) when its backend is not Ollama. These tests pin which API answers, the
 * wire shape of each call, and the readiness rule the rest of the app gates on.
 */

describe('which API answers AI calls', () => {
  it('is Ollama when nothing is configured — the local default this app has always used', () => {
    expect(llmBackendFromEnv({})).toBe('ollama');
  });

  it('is the OpenAI-compatible endpoint when the Hub gives one and no Ollama URL', () => {
    expect(llmBackendFromEnv({ APP_OPENAI_BASE_URL: 'http://hub:5002/api/inference/v1' })).toBe('openai');
  });

  it('keeps native Ollama when both are set — the Hub writes both when its backend is Ollama', () => {
    expect(
      llmBackendFromEnv({ APP_OPENAI_BASE_URL: 'http://hub:5002/api/inference/v1', APP_OLLAMA_URL: 'http://hub:11434' }),
    ).toBe('ollama');
    expect(llmBackendFromEnv({ OLLAMA_URL: 'http://ollama:11434', APP_OPENAI_BASE_URL: 'http://y/v1' })).toBe('ollama');
  });

  it('reads a blank value as unset, because the Hub writes its names even when they are empty', () => {
    expect(llmBackendFromEnv({ APP_OLLAMA_URL: '', APP_OPENAI_BASE_URL: '   ' })).toBe('ollama');
    expect(llmBackendFromEnv({ APP_OLLAMA_URL: '', APP_OPENAI_BASE_URL: 'http://y/v1' })).toBe('openai');
  });
});

describe('the OpenAI-compatible endpoint settings', () => {
  it('normalises the base to end in /v1, with no trailing slash', () => {
    expect(openAiCompatFromEnv({ APP_OPENAI_BASE_URL: 'http://hub:5002/api/inference/v1/' }).baseUrl).toBe(
      'http://hub:5002/api/inference/v1',
    );
    expect(openAiCompatFromEnv({ APP_OPENAI_BASE_URL: 'http://lemonade:8000' }).baseUrl).toBe('http://lemonade:8000/v1');
  });

  it('reads the key, the chat model and an optional embedding model, and is all blank when unset', () => {
    expect(
      openAiCompatFromEnv({
        APP_OPENAI_BASE_URL: 'http://hub/v1',
        APP_OPENAI_API_KEY: 'k',
        APP_CHAT_MODEL: 'qwen3:8b',
        APP_EMBED_MODEL: 'nomic-embed-text',
      }),
    ).toEqual({ baseUrl: 'http://hub/v1', apiKey: 'k', chatModel: 'qwen3:8b', embedModel: 'nomic-embed-text' });
    expect(openAiCompatFromEnv({})).toEqual({ baseUrl: '', apiKey: '', chatModel: '', embedModel: '' });
  });
});

describe('model pins from env', () => {
  it('pins both generation tiers to the Hub chat model on the OpenAI-compatible backend', () => {
    const m = ollamaModelsFromEnv({ APP_OPENAI_BASE_URL: 'http://hub/v1', APP_CHAT_MODEL: 'qwen3:8b' });
    expect(m.fastModel).toBe('qwen3:8b');
    expect(m.qualityModel).toBe('qwen3:8b');
    expect(m.pinned).toEqual({ fast: true, quality: true, embed: false });
  });

  it('lets an explicit OLLAMA_* pin win over the chat model', () => {
    const m = ollamaModelsFromEnv({
      APP_OPENAI_BASE_URL: 'http://hub/v1',
      APP_CHAT_MODEL: 'qwen3:8b',
      OLLAMA_FAST: 'tiny:1b',
    });
    expect(m.fastModel).toBe('tiny:1b');
    expect(m.qualityModel).toBe('qwen3:8b');
  });

  it('ignores the chat model on native Ollama, where the thinking-model filter must still apply', () => {
    const m = ollamaModelsFromEnv({ OLLAMA_URL: 'http://ollama:11434', APP_CHAT_MODEL: 'qwen3:8b' });
    expect(m.fastModel).toBe('qwen2.5:0.5b');
    expect(m.pinned.fast).toBe(false);
  });

  it('pins the embedding model from APP_EMBED_MODEL only on the OpenAI-compatible backend', () => {
    expect(ollamaModelsFromEnv({ APP_OPENAI_BASE_URL: 'http://hub/v1', APP_EMBED_MODEL: 'bge-m3' }).embedModel).toBe('bge-m3');
    expect(ollamaModelsFromEnv({ OLLAMA_URL: 'http://o', APP_EMBED_MODEL: 'bge-m3' }).embedModel).toBe('nomic-embed-text');
  });
});

/**
 * The adapter in mcp/ollama.ts, pointed at a stubbed endpoint. `config` is a singleton read once
 * at boot, so these tests set the fields the adapter reads and restore them afterwards — the
 * same way the Google mode is flipped at runtime.
 */
describe('the OpenAI-compatible adapter', () => {
  const BASE = 'http://hub.test/api/inference/v1';
  const KEY = 'secret-key-for-test';
  const saved = {
    llmBackend: config.llmBackend,
    openAiCompat: config.openAiCompat,
    ollamaFastModel: config.ollamaFastModel,
    ollamaQualityModel: config.ollamaQualityModel,
    ollamaEmbedModel: config.ollamaEmbedModel,
    pins: config.pins.ollama,
  };

  /** Stub fetch so each route answers from `routes`, keyed by the URL's ending. Records every call. */
  function stubEndpoint(routes: Record<string, () => Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
      const u = String(url);
      calls.push({ url: u, init });
      const route = Object.keys(routes).find((suffix) => u.endsWith(suffix));
      if (!route) throw new Error(`unexpected fetch: ${u}`);
      return routes[route]();
    });
    return calls;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  /** Point the adapter at the endpoint with a chat model, as the Hub would. */
  function useEndpoint(chatModel: string) {
    const m = ollamaModelsFromEnv({ APP_OPENAI_BASE_URL: BASE, APP_CHAT_MODEL: chatModel, APP_EMBED_MODEL: 'embed-test' });
    config.llmBackend = 'openai';
    config.openAiCompat = { baseUrl: BASE, apiKey: KEY, chatModel, embedModel: 'embed-test' };
    config.ollamaFastModel = m.fastModel;
    config.ollamaQualityModel = m.qualityModel;
    config.ollamaEmbedModel = m.embedModel;
    config.pins.ollama = m.pinned;
  }

  beforeEach(() => {
    resetProbeCache();
    // Resolution reads the owner's Settings overrides; clear them so these tests see only the endpoint.
    sqlite.prepare('UPDATE scheduling_prefs SET fast_model = NULL, quality_model = NULL, embed_model = NULL WHERE owner_id = ?').run(SYSTEM_OWNER);
    useEndpoint('qwen3:8b');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    config.llmBackend = saved.llmBackend;
    config.openAiCompat = saved.openAiCompat;
    config.ollamaFastModel = saved.ollamaFastModel;
    config.ollamaQualityModel = saved.ollamaQualityModel;
    config.ollamaEmbedModel = saved.ollamaEmbedModel;
    config.pins.ollama = saved.pins;
    resetProbeCache();
    setInstalledModels(null);
  });

  it('generate() posts a chat completion with the system prompt, JSON mode and the key', async () => {
    const calls = stubEndpoint({ '/chat/completions': () => json({ choices: [{ message: { content: '{"ok":true}' } }] }) });

    const out = await generate('Say ok', { purpose: 'classify', system: 'Be brief.', json: true });

    expect(out).toBe('{"ok":true}');
    expect(calls[0].url).toBe(`${BASE}/chat/completions`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Say ok' },
      ],
    });
  });

  it('generate() without JSON mode sends no response_format and no system message', async () => {
    const calls = stubEndpoint({ '/chat/completions': () => json({ choices: [{ message: { content: 'pong' } }] }) });
    expect(await generate('ping', { model: 'qwen3:8b', temperature: 0 })).toBe('pong');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).not.toHaveProperty('response_format');
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it('a non-OK chat answer is an OllamaUnavailable that names the endpoint and never the key', async () => {
    stubEndpoint({ '/chat/completions': () => new Response('upstream exploded', { status: 500 }) });

    const err = await generate('x', { model: 'qwen3:8b' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OllamaUnavailable);
    expect((err as Error).message).toContain(BASE);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('a 404 that names the model says which model is missing, not that the path is wrong', async () => {
    stubEndpoint({ '/chat/completions': () => new Response('{"error":"model not found"}', { status: 404 }) });

    const err = await generate('x', { model: 'nope:1b' }).catch((e: unknown) => e);

    expect((err as Error).message).toContain("Model 'nope:1b' is not available");
  });

  it('embed() posts to the embeddings route and reads the first vector', async () => {
    const calls = stubEndpoint({ '/embeddings': () => json({ data: [{ embedding: [0.25, 0.5] }] }) });

    expect(await embed('hello')).toEqual([0.25, 0.5]);
    expect(calls[0].url).toBe(`${BASE}/embeddings`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'embed-test', input: 'hello' });
  });

  it('status() reports the endpoint, and ready when the chat model is listed as held', async () => {
    stubEndpoint({
      '/models': () =>
        json({
          data: [
            { id: 'qwen3:8b', state: 'pulled' },
            { id: 'big-model:70b', state: 'available' },
            { id: 'embed-test', state: 'loaded' },
          ],
        }),
    });

    const s = await status();

    expect(s.provider).toBe('openai');
    expect(s.url).toBe(BASE);
    expect(s.available).toBe(true);
    // A row the Hub could fetch but has not pulled is not a model it can answer with.
    expect(s.models).toEqual(['qwen3:8b', 'embed-test']);
    expect(s.ready).toBe(true);
    expect(s.missingModels).not.toContain('qwen3:8b');
  });

  it('status() is not ready when the chat model is only available, not held', async () => {
    stubEndpoint({ '/models': () => json({ data: [{ id: 'qwen3:8b', state: 'available' }] }) });

    const s = await status();

    expect(s.ready).toBe(false);
    expect(s.missingModels).toContain('qwen3:8b');
  });

  it('a chat model of auto is ready exactly when the endpoint holds any model', async () => {
    useEndpoint('auto');

    stubEndpoint({ '/models': () => json({ data: [] }) });
    expect((await status()).ready).toBe(false);

    resetProbeCache();
    stubEndpoint({ '/models': () => json({ data: [{ id: 'qwen3:8b', state: 'pulled' }] }) });
    expect((await status()).ready).toBe(true);
  });

  it('status() reports an unreachable endpoint as unavailable, with the provider and URL', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const s = await status();

    expect(s.available).toBe(false);
    expect(s.ready).toBe(false);
    expect(s.provider).toBe('openai');
    expect(s.url).toBe(BASE);
  });

  it('the native backend still reports itself as ollama, at its own URL', async () => {
    config.llmBackend = 'ollama';
    stubEndpoint({ '/api/tags': () => json({ models: [{ name: 'qwen2.5:0.5b' }] }) });

    const s = await status();

    expect(s.provider).toBe('ollama');
    expect(s.url).toBe(config.ollamaUrl);
  });
});
