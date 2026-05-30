/**
 * V4.1: LLM model fallback. Mocks Ollama's HTTP API to prove generateWithFallback
 * skips models that fail to load and lands on one that works.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateWithFallback, setPreferredModel, setModels } from '../../src/llm.js';

const HOST = 'http://127.0.0.1:11434';
const realFetch = globalThis.fetch;

function mockOllama(handler: (url: string, body: any) => { status: number; json: any }) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [
        { name: 'qwen3.6:35b' }, { name: 'nemotron3:33b' }, { name: 'qwen2.5:0.5b' },
      ] }), { status: 200 });
    }
    const r = handler(u, body);
    return new Response(typeof r.json === 'string' ? r.json : JSON.stringify(r.json), { status: r.status });
  }) as typeof fetch;
}

beforeEach(() => setModels({ light: null, heavy: null }));
afterEach(() => { globalThis.fetch = realFetch; setModels({ light: null, heavy: null }); });

describe('generateWithFallback', () => {
  it('falls back past models that fail to load', async () => {
    const tried: string[] = [];
    mockOllama((url, body) => {
      if (url.endsWith('/api/generate')) {
        tried.push(body.model);
        if (body.model === 'qwen2.5:0.5b') return { status: 200, json: { response: 'ok' } };
        return { status: 500, json: { error: `unable to load model: ${body.model}` } };
      }
      return { status: 404, json: {} };
    });

    const { response, model } = await generateWithFallback({ prompt: 'hi' });
    expect(response).toBe('ok');
    expect(model).toBe('qwen2.5:0.5b');
    // It should have tried (and failed) the big models before landing on 0.5b
    expect(tried).toContain('qwen3.6:35b');
    expect(tried[tried.length - 1]).toBe('qwen2.5:0.5b');
  });

  it('honors a pinned preferred model first', async () => {
    const tried: string[] = [];
    mockOllama((url, body) => {
      if (url.endsWith('/api/generate')) {
        tried.push(body.model);
        return { status: 200, json: { response: 'pinned-ok' } };
      }
      return { status: 404, json: {} };
    });
    setPreferredModel('qwen2.5:0.5b');
    const { model } = await generateWithFallback({ prompt: 'hi' });
    expect(model).toBe('qwen2.5:0.5b');
    expect(tried[0]).toBe('qwen2.5:0.5b'); // tried first
  });

  it('throws when every model fails to load', async () => {
    mockOllama((url, body) => {
      if (url.endsWith('/api/generate')) return { status: 500, json: { error: `unable to load model: ${body.model}` } };
      return { status: 404, json: {} };
    });
    await expect(generateWithFallback({ prompt: 'hi' })).rejects.toThrow();
  });

  it('routes by tier: light → light model, heavy → heavy model first', async () => {
    // Make both pinned models available + answer
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'gemma4:e4b' }, { name: 'nemotron3:33b' }, { name: 'qwen2.5:0.5b' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ response: `from ${body.model}` }), { status: 200 });
    }) as typeof fetch;

    setModels({ light: 'gemma4:e4b', heavy: 'nemotron3:33b' });
    const light = await generateWithFallback({ prompt: 'x', tier: 'light' });
    const heavy = await generateWithFallback({ prompt: 'x', tier: 'heavy' });
    expect(light.model).toBe('gemma4:e4b');
    expect(heavy.model).toBe('nemotron3:33b');
  });
});
