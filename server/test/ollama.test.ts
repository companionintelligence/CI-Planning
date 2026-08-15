import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { status, generate, embed, embedReady, parseJsonLoose, resolveCall, CALL_POLICY, resetProbeCache } from '../src/mcp/ollama.js';
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

  // The TTL only helps once a probe has COMPLETED. The window before that is exactly when
  // callers pile up — boot, the Settings poll and isReady() on the authoring paths can all
  // land on a cold cache together — so concurrent callers must JOIN one request.
  it('concurrent callers on a cold cache share ONE /api/tags fetch', async () => {
    process.env.NODE_ENV = 'production';

    // Gate the stub so all three callers are provably in flight before any can finish.
    // With an immediately-resolving stub this would pass on internal await ordering rather
    // than on the dedupe actually working.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (!String(url).endsWith('/api/tags')) throw new Error(`unexpected fetch: ${url}`);
      tagFetches++;
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'probe-fast:latest', capabilities: ['completion', 'tools'], details: { parameter_size: '3.2B' } }] }),
      } as unknown as Response;
    });

    const all = Promise.all([status(), status(), status()]);
    release();
    const [a, b, c] = await all;

    expect(tagFetches).toBe(1);
    // Every joiner gets a real answer, not a placeholder.
    for (const s of [a, b, c]) expect(s.available).toBe(true);
  });

  // "Re-check" means "read it AFTER I asked". A probe already in flight may have been issued
  // before the user clicked, so fresh must not join one — it would answer a stale question.
  it('fresh:true does NOT join an in-flight probe', async () => {
    process.env.NODE_ENV = 'production';

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (!String(url).endsWith('/api/tags')) throw new Error(`unexpected fetch: ${url}`);
      tagFetches++;
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'probe-fast:latest', capabilities: ['completion', 'tools'], details: { parameter_size: '3.2B' } }] }),
      } as unknown as Response;
    });

    const joined = Promise.all([status(), status()]);          // these two share one
    const forced = status(undefined, { fresh: true });          // this one must not
    release();
    await Promise.all([joined, forced]);

    expect(tagFetches).toBe(2);
  });

  // A slower EARLIER probe must not overwrite a faster LATER one. Both write the cache, so
  // without an issue-order guard `fresh` defeats itself: the Re-check reading lands, then the
  // older in-flight request completes and replaces it — under a NEWER timestamp, which then
  // serves every caller for the rest of the TTL. This test fails without that guard.
  it('a late-landing earlier probe does not clobber the Re-check reading', async () => {
    process.env.NODE_ENV = 'production';

    // Two gates, released in reverse issue order: probe #1 (non-fresh) finishes LAST.
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((r) => { releaseFirst = r; });
    const second = new Promise<void>((r) => { releaseSecond = r; });

    const models = (name: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name, capabilities: ['completion', 'tools'], details: { parameter_size: '3.2B' } }] }),
    }) as unknown as Response;

    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (!String(url).endsWith('/api/tags')) throw new Error(`unexpected fetch: ${url}`);
      tagFetches++;
      if (tagFetches === 1) { await first; return models('stale-probe:latest'); }
      await second; return models('recheck-probe:latest');
    });

    const stale = status();                                   // issued first
    const rechecked = status(undefined, { fresh: true });     // issued second
    releaseSecond();                                          // …but lands FIRST
    await rechecked;
    releaseFirst();
    await stale;

    expect(tagFetches).toBe(2);
    // The cache must hold the Re-check reading, not the one issued before it.
    const served = await status();
    expect(served.models).toEqual(['recheck-probe:latest']);
  });

  // An unreachable Ollama is cached like any other reading — deliberately, so a down Ollama
  // is not hammered once per authoring call. The cost is up to PROBE_TTL_MS of staleness once
  // it comes back, which is precisely what "Re-check" (fresh) exists to cover. Pinned because
  // "failures are cached too" is the non-obvious half, and the in-flight join must not make a
  // failure sticky beyond its TTL.
  it('a failed probe is cached like any other, and fresh still retries it', async () => {
    process.env.NODE_ENV = 'production';

    vi.stubGlobal('fetch', async () => { tagFetches++; throw new Error('connection refused'); });

    const first = await status();
    expect(first.available).toBe(false);

    const second = await status();
    expect(tagFetches).toBe(1);        // served from cache — the down Ollama is not re-probed
    expect(second.available).toBe(false);

    const rechecked = await status(undefined, { fresh: true });
    expect(tagFetches).toBe(2);        // …and Re-check gets through, so nothing is stuck
    expect(rechecked.available).toBe(false);
  });
});

/**
 * `embedReady()` — the readiness question the EMBEDDING paths ask (Triality's novelty
 * blend, services/triality.ts). Deliberately not `ready`: that one is the generation
 * pair, so a box with a chat model and no embedder reports ready for AI features while
 * every `/api/embeddings` call would 404.
 *
 * Like the block above, these have to leave test mode: the probe only fills the
 * installed-model cache outside it, and "the cache is unknown under NODE_ENV=test" is
 * itself one of the cases pinned here — it is what keeps the rest of the suite off the
 * embedding path and therefore deterministic.
 */
describe('embedReady()', () => {
  const SAVED_NODE_ENV = process.env.NODE_ENV;
  const EMBEDDER = 'probe-embed:latest';

  /** `null` ⇒ the probe fails. Capabilities are irrelevant here: the effective embedder
   *  is a Settings override, so nothing is auto-selected — only "is it in the list". */
  function stubTags(models: string[] | null) {
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (!String(url).endsWith('/api/tags')) throw new Error(`unexpected fetch: ${url}`);
      if (!models) throw new Error('connection refused');
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: models.map((name) => ({ name, capabilities: ['embedding'] })) }),
      } as unknown as Response;
    });
  }

  beforeEach(() => {
    resetProbeCache();
    sqlite.prepare(`UPDATE scheduling_prefs SET embed_model = ? WHERE owner_id = ?`).run(EMBEDDER, SYSTEM_OWNER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = SAVED_NODE_ENV;
    resetProbeCache();
    setInstalledModels(null);   // hand the suite back its "never probed" state
    sqlite.prepare(`UPDATE scheduling_prefs SET embed_model = NULL WHERE owner_id = ?`).run(SYSTEM_OWNER);
  });

  it('true only while the owner’s EFFECTIVE embedder is pulled', async () => {
    process.env.NODE_ENV = 'production';

    stubTags([EMBEDDER, 'probe-chat:latest']);
    expect(await embedReady(SYSTEM_OWNER)).toBe(true);

    // The same reachable Ollama, one model short — reachable is not ready.
    resetProbeCache();
    stubTags(['probe-chat:latest']);
    expect(await embedReady(SYSTEM_OWNER)).toBe(false);
  });

  it('unknown counts as NOT ready — a failed probe, and the whole test suite', async () => {
    process.env.NODE_ENV = 'production';
    stubTags(null);
    expect(await embedReady(SYSTEM_OWNER)).toBe(false);

    // Under NODE_ENV=test the probe never feeds the installed cache (applyInstalled), so
    // this is false even though the embedder is right there in the tags list.
    process.env.NODE_ENV = 'test';
    resetProbeCache();
    stubTags([EMBEDDER]);
    expect(await embedReady(SYSTEM_OWNER)).toBe(false);
  });
});
