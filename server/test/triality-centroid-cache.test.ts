import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner, ALL_SCOPES } from '../src/lib/context.js';
import {
  trialityNext, __resetCentroidCache, __centroidCacheSize, __primeCentroidCacheForTest,
} from '../src/services/triality.js';
import { resetProbeCache } from '../src/mcp/ollama.js';
import { setInstalledModels } from '../src/lib/models.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

/**
 * The centroid cache (services/triality.ts) — the follow-up to the novelty-budget
 * cancellation fix.
 *
 * `noveltyScores` re-embedded the SAME 25 completed-task titles on every request to
 * rebuild a centroid that, absent a new completion, was bit-for-bit identical to the
 * last one — the single largest block of repeated model work in the scoring path.
 * These prove the fix actually skips that work on a hit, and — more importantly, since
 * a wrong cache is worse than no cache — that it invalidates correctly:
 *   - a changed completion history forces a rebuild,
 *   - a changed embedding model forces a rebuild,
 *   - two owners with identical titles never share an entry,
 *   - the cache itself cannot grow without bound.
 *
 * Fixture style follows triality-engine.test.ts (raw sqlite, frozen NOW) plus
 * ollama.test.ts's `embedReady()` fixture (stubGlobal('fetch', ...) for /api/tags +
 * /api/embeddings, NODE_ENV=production so the probe actually fills the installed-model
 * cache). The cache only activates on the DEFAULT embedder path (embedFn === undefined
 * — see noveltyScores), so proving it works means going through that real path rather
 * than an injected fake.
 *
 * Every trialityNext call runs inside runWithOwner. This is NOT optional scaffolding:
 * ollama.embed()'s owner param defaults to currentOwnerId(), which falls back to
 * SYSTEM_OWNER only under NODE_ENV=test — and this file needs 'production' so the
 * probe actually populates the installed-model list embedReady() checks against.
 * Without the wrap, currentOwnerId() throws, embed() never reaches fetch, and every
 * call here silently degrades to the categorical fallback with zero HTTP calls —
 * exactly the failure mode this comment exists to keep the next editor from re-finding
 * the hard way.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const EMBEDDER = 'centroid-cache-embed:latest';
const EMBED_DIM = 8;

const next = (owner: string) => runWithOwner(owner, ALL_SCOPES, () => trialityNext(owner, NOW, {}));

function insertTask(
  title: string,
  owner: string,
  o: { status?: string; completedAt?: string; mood?: string; estimate?: number | null } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, completed_at, completion_mood, priority)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, 3)`,
    )
    .run(title, owner, o.status ?? 'open', o.estimate === undefined ? 30 : o.estimate, o.completedAt ?? null, o.mood ?? null);
}

/** 12 confirmed completions — clears the refusal floor (10) and gives the centroid a
 *  title set well under CENTROID_TITLES (25), so its exact size is easy to assert on. */
function seedHistory(owner: string): void {
  for (let i = 0; i < 12; i++) insertTask(`done-${i}`, owner, { status: 'done', completedAt: daysAgo(1 + (i % 30)), mood: 'flat' });
}

function seedCandidates(owner: string): void {
  insertTask('write report', owner, { estimate: 45 });
  insertTask('call plumber', owner, { estimate: 15 });
  insertTask('sketch garden plan', owner, { estimate: 60 });
}

const embedCalls: string[] = [];

/** Mirrors ollama.test.ts's embedReady() fixture: /api/tags lists the given embedder(s)
 *  (so embedReady + resolution succeed), /api/embeddings returns a fixed-dim vector and
 *  logs the prompt so call COUNT is observable. */
function stubOllama(models: string[] = [EMBEDDER]): void {
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return {
        ok: true, status: 200,
        json: async () => ({ models: models.map((name) => ({ name, capabilities: ['embedding'] })) }),
      } as unknown as Response;
    }
    if (u.endsWith('/api/embeddings')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      embedCalls.push(body.prompt ?? '');
      return {
        ok: true, status: 200,
        json: async () => ({ embedding: Array.from({ length: EMBED_DIM }, (_, i) => (i + 1) / EMBED_DIM) }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

const SAVED_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  resetDb();
  __resetCentroidCache();
  resetProbeCache();
  embedCalls.length = 0;
  process.env.NODE_ENV = 'production'; // the probe only fills the installed-model cache outside test mode
  sqlite.prepare(`UPDATE scheduling_prefs SET embed_model = ? WHERE owner_id = ?`).run(EMBEDDER, OWNER);
  stubOllama();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = SAVED_NODE_ENV;
  resetProbeCache();
  setInstalledModels(null);
  __resetCentroidCache();
});

describe('centroid cache — hit avoids re-embedding the history', () => {
  it('the second call for the same owner embeds only the candidates, not the 12 titles again', async () => {
    seedHistory(OWNER);
    seedCandidates(OWNER);

    const first = await next(OWNER);
    expect(first.refused).toBeUndefined();
    const afterFirst = embedCalls.length;
    // Centroid (12 titles) + 3 candidates on a cold cache.
    expect(afterFirst).toBe(15);

    const second = await next(OWNER);
    expect(second.refused).toBeUndefined();
    const secondCallCost = embedCalls.length - afterFirst;
    // Only the 3 candidates — the 12 history titles were NOT re-embedded.
    expect(secondCallCost).toBe(3);

    // Same input, same answer — the cache changes cost, not correctness.
    expect(second).toEqual(first);
  });
});

describe('centroid cache — invalidation', () => {
  it('a new completion changes the title set and forces a rebuild', async () => {
    seedHistory(OWNER);
    seedCandidates(OWNER);
    await next(OWNER);
    const afterFirst = embedCalls.length;

    await next(OWNER); // cache hit — cheap
    expect(embedCalls.length - afterFirst).toBe(3);
    const afterHit = embedCalls.length;

    // A 13th, more recent completion — the title SET the centroid is built from changes.
    insertTask('done-new', OWNER, { status: 'done', completedAt: daysAgo(0.5), mood: 'flat' });
    await next(OWNER);
    // Full rebuild: 13 history titles (still under the 25 cap) + 3 candidates.
    expect(embedCalls.length - afterHit).toBe(16);
  });

  it('an embedder change forces a rebuild even with identical titles', async () => {
    seedHistory(OWNER);
    seedCandidates(OWNER);
    await next(OWNER);
    const afterFirst = embedCalls.length;

    // Swap to a second model that is ALSO in the stubbed /api/tags list, so embedReady
    // still passes — only the fingerprint's model half should change.
    const OTHER = 'centroid-cache-embed-2:latest';
    stubOllama([EMBEDDER, OTHER]);
    // The /api/tags PROBE is cached for PROBE_TTL_MS (30s) independent of which model
    // this test just started stubbing — without dropping it, embedReady() replays the
    // FIRST call's stale, EMBEDDER-only probe, OTHER is absent from it, and the call
    // degrades to categorical for a reason that has nothing to do with what this test
    // is proving.
    resetProbeCache();
    sqlite.prepare(`UPDATE scheduling_prefs SET embed_model = ? WHERE owner_id = ?`).run(OTHER, OWNER);

    await next(OWNER);
    // Same 12 titles, different model → the fingerprint misses → full rebuild, not the
    // 3-call cache-hit cost.
    expect(embedCalls.length - afterFirst).toBe(15);
  });
});

describe('centroid cache — per-owner isolation', () => {
  it('a second owner with identical titles never reuses the first owner’s entry', async () => {
    seedHistory(OWNER);           // also sets OWNER's embed_model, which createOwner clones below
    seedCandidates(OWNER);
    createOwner(SECOND_OWNER_ID, 'Owner B', 'UTC');
    // The exact same title set, under a different owner_id.
    seedHistory(SECOND_OWNER_ID);
    seedCandidates(SECOND_OWNER_ID);

    await next(OWNER);
    const afterOwnerA = embedCalls.length;
    expect(afterOwnerA).toBe(15); // cold build for A

    await next(SECOND_OWNER_ID);
    // If B reused A's cache entry this would be 3 (candidates only). It must pay the
    // full 15 — content-identical titles are not identity across owners.
    expect(embedCalls.length - afterOwnerA).toBe(15);
  });
});

describe('centroid cache — bounded size', () => {
  it('never grows past its ceiling, even fed more owners than the ceiling allows', () => {
    // Unit-level: the LRU mechanics don't need a DB or a model behind them, and driving
    // 65+ owners through a full trialityNext each would be slow for no extra assurance —
    // the eviction logic is pure Map bookkeeping.
    for (let i = 0; i < 200; i++) {
      __primeCentroidCacheForTest(`owner-${i}`, 'fp', [0, 1, 2]);
    }
    expect(__centroidCacheSize()).toBeLessThanOrEqual(64);
  });
});
