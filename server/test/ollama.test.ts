import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { status, generate, embed, parseJsonLoose, resolveCall, CALL_POLICY, resetProbeCache } from '../src/mcp/ollama.js';
import { setInstalledModels } from '../src/lib/models.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { ollamaAvailable } from './helpers.js';

describe('ollama client', () => {
  let up = false;
  beforeAll(async () => {
    up = await ollamaAvailable();
  });

  it('status() always returns a well-formed object (never throws)', async () => {
    const s = await status();
    expect(s).toHaveProperty('available');
    expect(s).toHaveProperty('url');
    expect(Array.isArray(s.models)).toBe(true);
    expect(typeof s.fastModel).toBe('string');
    expect(typeof s.qualityModel).toBe('string');
  });

  it('parseJsonLoose handles fenced and prose-wrapped JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('Here you go: {"a":3} cheers')).toEqual({ a: 3 });
    expect(parseJsonLoose('[1,2,3]')).toEqual([1, 2, 3]);
    expect(() => parseJsonLoose('not json at all')).toThrow();
  });

  it('generate() returns text when Ollama is available', async () => {
    if (!up) return; // skip gracefully when Ollama is down
    const out = await generate('Reply with the single word: pong', { tier: 'fast', temperature: 0 });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('embed() returns a numeric vector when available', async () => {
    if (!up) return;
    const vec = await embed('a quick test sentence');
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBeGreaterThan(0);
    expect(typeof vec[0]).toBe('number');
  });

  it('an explicit temperature/timeoutMs still overrides the named purpose', () => {
    // The purpose supplies defaults; a call site that states a value keeps winning, which
    // is what lets render-copy carry a per-surface tier and timeout with no new machinery.
    expect(CALL_POLICY.classify).toEqual({ tier: 'fast', temperature: 0.1, timeoutMs: 15_000 });
    expect(resolveCall({ purpose: 'classify', temperature: 0.55, timeoutMs: 7_000 })).toEqual({
      tier: 'fast',
      temperature: 0.55,
      timeoutMs: 7_000,
    });
  });

  it('reports installed models including the configured small model', async () => {
    if (!up) return;
    const s = await status();
    expect(s.available).toBe(true);
    expect(s.models.length).toBeGreaterThan(0);
  });
});

/**
 * The probe cache. `status()` sits under `isReady()`, which every plan render, every
 * `authorPlanOrder` and every `parseInstruction` calls — so the `/api/tags` fetch is on
 * hot paths, not just the Settings poll. Exactly ONE half of `status()` is cached: the
 * probe. Model resolution is redone on every call, because a Settings override is a DB
 * write that must land on the very next request.
 *
 * The cache is disabled under NODE_ENV=test (same rule as the setInstalledModels guard,
 * and for the same reason: no suite may depend on which test probed first), so these
 * tests have to leave test mode deliberately — and put it back.
 */
describe('status() probe cache', () => {
  const SAVED_NODE_ENV = process.env.NODE_ENV;
  let tagFetches = 0;

  /** A stubbed /api/tags that counts reads. Anything else is a test bug, not a fallback. */
  function stubTags(models: string[]) {
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      if (!u.endsWith('/api/tags')) throw new Error(`unexpected fetch: ${u}`);
      tagFetches++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: models.map((name) => ({
            name,
            capabilities: ['completion', 'tools'],
            details: { parameter_size: '3.2B' },
          })),
        }),
      } as unknown as Response;
    });
  }

  beforeEach(() => {
    tagFetches = 0;
    resetProbeCache();
    stubTags(['probe-fast:latest', 'probe-quality:latest', 'probe-embed:latest']);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = SAVED_NODE_ENV;
    resetProbeCache();
    // These tests ran outside test mode, so the probe filled the auto-select cache.
    // Hand the rest of the suite back the "never probed" state it was written against.
    setInstalledModels(null);
    sqlite
      .prepare(`UPDATE scheduling_prefs SET fast_model = NULL WHERE owner_id = ?`)
      .run(SYSTEM_OWNER);
  });

  it('two calls inside the TTL issue ONE /api/tags fetch; fresh:true issues a second', async () => {
    process.env.NODE_ENV = 'production';

    await status();
    await status();
    expect(tagFetches).toBe(1);

    await status(undefined, { fresh: true });
    expect(tagFetches).toBe(2);

    // …and the refilled cache serves the next call again.
    await status();
    expect(tagFetches).toBe(2);
  });

  it('is disabled under NODE_ENV=test — every call probes', async () => {
    process.env.NODE_ENV = 'test';
    await status();
    await status();
    expect(tagFetches).toBe(2);
  });

  it('a model override saved between two CACHED calls lands on the second', async () => {
    // The regression test for the one way this cache could do real harm: if resolution
    // were cached alongside the probe, a model saved in Settings would appear not to
    // apply until the TTL expired.
    process.env.NODE_ENV = 'production';

    const before = await status(SYSTEM_OWNER);
    expect(before.modelSources.fast).not.toBe('override');

    sqlite
      .prepare(`UPDATE scheduling_prefs SET fast_model = ? WHERE owner_id = ?`)
      .run('override-me:latest', SYSTEM_OWNER);

    const after = await status(SYSTEM_OWNER);
    expect(after.fastModel).toBe('override-me:latest');
    expect(after.modelSources.fast).toBe('override');
    // …and the probe underneath was still served from the cache.
    expect(tagFetches).toBe(1);
  });
});
