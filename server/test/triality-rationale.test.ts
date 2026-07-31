import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Triality T9 — the rationale GARNISH (design §8, §2 two-clocks doctrine).
 *
 * The invariants under test, in order of how much they matter:
 *   1. GARNISH INVARIANCE — picks, slots, ordering and every score number are
 *      byte-identical whether the garnish runs, fails, or is disabled; and the
 *      scoring path does not import the garnish at all (a structural assertion,
 *      because that is the property no behavioral test can fully cover).
 *   2. THE TEMPLATE IS THE SPEC — computed first, always, for every pick; the
 *      model can only REPLACE a line, never author the only one.
 *   3. ONE call, all three picks, one hard budget (probe included).
 *   4. HONEST LABELLING — every pick carries a source; 'ai' only for a model line.
 *   5. Ollama only (there is no second provider seam in the module).
 */

// Mocked at the module seam so no test can reach a developer's running Ollama —
// `status` decides availability, `generateJson` records the single call, and the
// engine's embedding path is stubbed shut (its ladder is T3's business, not T9's).
let ollamaReady = false;
let genResponse: unknown = {};
let genThrows: Error | null = null;
/** Counts the DEFAULT availability probe. The probe is a network fetch with a
 *  multi-second abort, so "was it called at all" is itself an invariant. */
let statusCalls = 0;
const genCalls: { prompt: string; opts: { tier?: string; timeoutMs?: number } }[] = [];

vi.mock('../src/mcp/ollama.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/mcp/ollama.js')>();
  return {
    ...actual,
    generateJson: vi.fn(async (prompt: string, opts: { tier?: string; timeoutMs?: number } = {}) => {
      genCalls.push({ prompt, opts });
      if (genThrows) throw genThrows;
      return genResponse;
    }),
    status: vi.fn(async () => {
      statusCalls++;
      return {
        available: ollamaReady,
        ready: ollamaReady,
        url: 'http://mock',
        models: [],
        smallModel: 'mock-small',
        mediumModel: 'mock-medium',
        embedModel: 'mock-embed',
        missingModels: [],
      };
    }),
    ollama: {
      ...actual.ollama,
      embed: async () => {
        throw new Error('embeddings are stubbed off in T9 tests');
      },
    },
  };
});

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { trialityNext, type ScoredPick, type Slot } from '../src/services/triality.js';
import { DIM_REGISTRY, type DimName, type SituationVector, type Ternary } from '../src/services/triality-vector.js';
import { attachRationales, templateRationale } from '../src/services/triality-rationale.js';

const OWNER = SYSTEM_OWNER;

/** Fixed anchor — every seeded date is derived from it, so nothing here rots. */
const NOW = new Date('2026-03-10T12:00:00.000Z');

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

beforeEach(() => {
  resetDb();
  ollamaReady = false;
  genResponse = {};
  genThrows = null;
  genCalls.length = 0;
  statusCalls = 0;
});

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A full ternary vector: every dim honest-zero unless named, every dim active
 *  unless an explicit active list is given. */
function vector(over: Partial<Record<DimName, Ternary>> = {}, active?: DimName[]): SituationVector {
  const dims = {} as Record<DimName, Ternary>;
  for (const d of DIM_REGISTRY) dims[d.name] = 0;
  Object.assign(dims, over);
  return { dims, meta: { active: active ?? DIM_REGISTRY.map((d) => d.name) } };
}

function pick(slot: Slot, over: Partial<ScoredPick> = {}): ScoredPick {
  return {
    kind: 'task',
    ref: `${slot}-ref`,
    title: `${slot} action`,
    estimateMin: 20,
    direction: 'work',
    categories: [],
    motivation: null,
    slot,
    scores: { F: 0.2, H: 0.9, Q: 0.1, N: 0.1, C: 0.3, total: 0.5 },
    ternary: [1, 0, 1],
    // v2.2 telemetry. Present only because ScoredPick requires it — the garnish reads
    // neither field, and every assertion in this file must stay true whatever these say.
    decision: { eligible: 2, dot: 2, score: 0.5, runnerUpDot: 1, runnerUpScore: 0.4 },
    evidenceRows: 5,
    ...over,
  };
}

const ALL_THREE = { habitual: 'Model line one.', contextual: 'Model line two.', novel: 'Model line three.' };

function seedHistory(n: number, now = NOW): void {
  const stmt = sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, completed_at, completion_mood)
     VALUES (uuid7(), ?, ?, 'done', ?, 'flat')`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run(`done-${i}`, OWNER, new Date(now.getTime() - (i + 1) * 86_400_000).toISOString());
  }
}

function seedOpen(title: string, estimate: number): void {
  sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes) VALUES (uuid7(), ?, ?, 'open', ?)`)
    .run(title, OWNER, estimate);
}

const enableFlag = () =>
  sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);

// ── 2. the deterministic template is the spec ─────────────────────────────────

describe('the deterministic template (the spec)', () => {
  it('names the dominant weighted component and the first fired dim', async () => {
    const line = templateRationale(pick('habitual'), vector({ day_type: 1 }));
    expect(line).toBe('Something you do often, and today is a work day.');
  });

  it('never names a component the slot does not weight', () => {
    // Contextual weights F/H/N only — a towering Q or C is not why it was picked.
    const p = pick('contextual', { scores: { F: 0.4, H: 0.1, Q: 0.99, N: 0.2, C: 0.99, total: 0.4 } });
    expect(templateRationale(p, vector())).toBe('Fits your current situation.');
  });

  it('drops the dim half when nothing in the situation fired', () => {
    expect(templateRationale(pick('novel', { scores: { F: 0, H: 0, Q: 0, N: 0.8, C: 0.1, total: 0.3 } }), vector()))
      .toBe('Unlike your usual pattern.');
  });

  it('an all-zero pool gets the honest zero, never a confident reason', () => {
    const p = pick('habitual', { scores: { F: 0, H: 0, Q: 0, N: 0, C: 0, total: 0 } });
    expect(templateRationale(p, vector({ momentum: -1 }))).toBe(
      "No single component stood out, and you've been idle a while.",
    );
  });

  it('an INACTIVE dim is never quoted, even when non-zero', () => {
    // in_work_hours would win registry order, but its source is off this call.
    const v = vector({ in_work_hours: -1, day_type: -1 }, ['day_type']);
    expect(templateRationale(pick('habitual'), v)).toBe('Something you do often, and today is a rest day.');
  });

  it('a category deficit reads as under-served / over-served', () => {
    expect(templateRationale(pick('habitual'), vector({ cat_deficit_health: 1 }))).toContain('health is under-served');
    expect(templateRationale(pick('habitual'), vector({ cat_deficit_health: -1 }))).toContain('health is over-served');
  });

  it('every pick gets a template line before any model is consulted', async () => {
    const picks = [pick('habitual'), null, pick('novel')];
    const out = await attachRationales(picks, vector(), { generateFn: null });
    expect(out.map((r) => r?.source ?? null)).toEqual(['template', null, 'template']);
    expect(out[0]!.text.length).toBeGreaterThan(0);
    expect(out[2]!.text.length).toBeGreaterThan(0);
  });
});

// ── 3. at most one call, one hard budget ──────────────────────────────────────

describe('one model call, hard budget', () => {
  it('covers all three picks in ONE constrained-JSON round trip', async () => {
    ollamaReady = true;
    genResponse = ALL_THREE;
    const out = await attachRationales([pick('habitual'), pick('contextual'), pick('novel')], vector());
    expect(genCalls.length).toBe(1);
    expect(out.map((r) => r!.source)).toEqual(['ai', 'ai', 'ai']);
    // Output shape first (the measured 3B rule), all three keys in it, data last.
    expect(genCalls[0].prompt.startsWith('Reply with JSON only, exactly these keys:')).toBe(true);
    for (const slot of ['habitual', 'contextual', 'novel']) expect(genCalls[0].prompt).toContain(`"${slot}"`);
    expect(genCalls[0].opts.tier).toBe('small');
  });

  it('the call carries the remaining budget as its timeout, never above 5s', async () => {
    ollamaReady = true;
    genResponse = ALL_THREE;
    let t = 0;
    await attachRationales([pick('habitual')], vector(), {
      clockMs: () => t,
      availableFn: async () => { t += 1_000; return true; },
    });
    expect(genCalls.length).toBe(1);
    expect(genCalls[0].opts.timeoutMs).toBe(4_000);
    expect(genCalls[0].opts.timeoutMs!).toBeLessThanOrEqual(5_000);
  });

  it('a probe that eats the budget skips the call entirely — no stall past the deadline', async () => {
    let t = 0;
    const gen = vi.fn(async () => ALL_THREE);
    const out = await attachRationales([pick('habitual')], vector(), {
      clockMs: () => t,
      availableFn: async () => { t += 4_900; return true; },
      generateFn: gen,
    });
    expect(gen).not.toHaveBeenCalled();
    expect(out[0]!.source).toBe('template');
  });

  it('Ollama unreachable (not ready) → no call at all, templates stand', async () => {
    ollamaReady = false;
    const out = await attachRationales([pick('habitual'), pick('novel')], vector());
    expect(genCalls.length).toBe(0);
    expect(out.map((r) => r!.source)).toEqual(['template', 'template']);
  });

  it('a probe that throws degrades to templates without throwing', async () => {
    const out = await attachRationales([pick('habitual')], vector(), {
      availableFn: async () => { throw new Error('ollama probe blew up'); },
    });
    expect(out[0]!.source).toBe('template');
  });

  it('a timed-out / dead call degrades to templates without throwing', async () => {
    ollamaReady = true;
    genThrows = new Error('Ollama request timed out after 5000ms');
    const out = await attachRationales([pick('habitual'), pick('contextual')], vector());
    expect(genCalls.length).toBe(1);
    expect(out.every((r) => r!.source === 'template')).toBe(true);
  });

  it('garbage output of every shape degrades to templates', async () => {
    ollamaReady = true;
    for (const garbage of ['not json at all', ['habitual'], null, { habitual: 42 }, { habitual: '   ' }, { other: 'x' }]) {
      genResponse = garbage;
      const out = await attachRationales([pick('habitual')], vector());
      expect(out[0]!.source).toBe('template');
    }
  });

  it('no picks at all → not even the PROBE runs (an empty banner never pays for inference)', async () => {
    ollamaReady = true;
    genResponse = ALL_THREE;
    // Asserting only the generate count would pass for the wrong reason: the probe
    // is itself a ~5s-abort fetch, so three nulls must cost ZERO round trips.
    const probe = vi.fn(async () => true);
    const gen = vi.fn(async () => ALL_THREE);
    const out = await attachRationales([null, null, null], vector(), { availableFn: probe, generateFn: gen });
    expect(probe).not.toHaveBeenCalled();
    expect(gen).not.toHaveBeenCalled();
    expect(out).toEqual([null, null, null]);

    // …and the same on the DEFAULT path, where the probe is Ollama's own `ready`.
    expect(await attachRationales([null, null, null], vector())).toEqual([null, null, null]);
    expect(statusCalls).toBe(0);
    expect(genCalls.length).toBe(0);
  });
});

// ── 4. honest labelling ───────────────────────────────────────────────────────

describe('honest labelling', () => {
  it('a partial answer yields mixed labels — never `ai` for a template line', async () => {
    ollamaReady = true;
    genResponse = { contextual: 'Because the afternoon is open.' };
    const out = await attachRationales([pick('habitual'), pick('contextual'), pick('novel')], vector({ day_type: 1 }));
    expect(out.map((r) => r!.source)).toEqual(['template', 'ai', 'template']);
    expect(out[1]!.text).toBe('Because the afternoon is open.');
    expect(out[0]!.text).toBe('Something you do often, and today is a work day.');
  });

  it('a model line is normalized to ONE line and capped', async () => {
    ollamaReady = true;
    genResponse = { habitual: `  "You do this\n  most mornings."  ${'x'.repeat(200)}` };
    const out = await attachRationales([pick('habitual')], vector());
    expect(out[0]!.source).toBe('ai');
    expect(out[0]!.text).not.toContain('\n');
    expect(out[0]!.text.length).toBeLessThanOrEqual(140);
    expect(out[0]!.text.startsWith('You do this most mornings.')).toBe(true);
  });

  it('disabled → every line is a labeled template and nothing is called', async () => {
    ollamaReady = true;
    genResponse = ALL_THREE;
    const out = await attachRationales([pick('habitual'), pick('novel')], vector(), { generateFn: null });
    expect(genCalls.length).toBe(0);
    expect(out.every((r) => r!.source === 'template')).toBe(true);
  });
});

// ── 1. garnish invariance ─────────────────────────────────────────────────────

describe('garnish invariance', () => {
  /** The engine's own output for a fixed DB + fixed `now`, embeddings off. */
  const run = () => trialityNext(OWNER, NOW, { embedFn: null });

  beforeEach(() => {
    seedHistory(12);
    seedOpen('Reply to the sprint thread', 20);
    seedOpen('Walk the long loop', 35);
    seedOpen('Draft the quarterly note', 50);
  });

  it('picks, slots, ordering and every score number survive all three arms untouched', async () => {
    const baseline = await run();
    expect(baseline.refused).toBeUndefined();
    const snapshot = JSON.stringify(baseline);

    // arm 1 — disabled
    await attachRationales(baseline.picks!, baseline.vector!, { generateFn: null });
    expect(JSON.stringify(baseline)).toBe(snapshot);

    // arm 2 — the model answers
    ollamaReady = true;
    genResponse = ALL_THREE;
    const withAi = await run();
    const aiOut = await attachRationales(withAi.picks!, withAi.vector!);
    expect(aiOut.some((r) => r?.source === 'ai')).toBe(true);
    expect(JSON.stringify(withAi)).toBe(snapshot);

    // arm 3 — the model fails
    genThrows = new Error('ollama died mid-call');
    const withFailure = await run();
    const failOut = await attachRationales(withFailure.picks!, withFailure.vector!);
    expect(failOut.every((r) => r === null || r.source === 'template')).toBe(true);
    expect(JSON.stringify(withFailure)).toBe(snapshot);

    // and a run AFTER a garnished one still scores identically — the garnish
    // leaves no state the engine could read.
    genThrows = null;
    expect(JSON.stringify(await run())).toBe(snapshot);
  });

  it('the scoring path does not import the garnish (structural, not behavioral)', () => {
    for (const file of ['triality.ts', 'triality-vector.ts', 'triality-metrics.ts']) {
      const src = readFileSync(new URL(`../src/services/${file}`, import.meta.url), 'utf8');
      expect(src).not.toContain('triality-rationale');
    }
  });

  it('Ollama is the only provider seam in the garnish', () => {
    const src = readFileSync(new URL('../src/services/triality-rationale.ts', import.meta.url), 'utf8');
    expect(src).toContain("from '../mcp/ollama.js'");
    expect(src).not.toMatch(/openai|anthropic|api\.openai|gemini|claude-3/i);
  });
});

// ── the wire: REST snake_case + GraphQL parity ────────────────────────────────

describe('the wire', () => {
  beforeEach(() => {
    enableFlag();
    // Route handlers read the wall clock, so these seeds are relative to real now.
    seedHistory(12, new Date());
    seedOpen('Reply to the sprint thread', 20);
    seedOpen('Walk the long loop', 35);
    seedOpen('Draft the quarterly note', 50);
  });

  it('REST carries rationale + rationale_source on every pick (template when Ollama is out)', async () => {
    const res = await api(srv.url, '/api/triality/next');
    expect(res.status).toBe(200);
    const body = res.body as { picks: ({ rationale: string; rationale_source: string } | null)[] };
    const live = body.picks.filter((p): p is { rationale: string; rationale_source: string } => !!p);
    expect(live.length).toBeGreaterThan(0);
    for (const p of live) {
      expect(p.rationale.length).toBeGreaterThan(0);
      expect(p.rationale_source).toBe('template');
    }
  });

  it("REST labels a model line 'ai'", async () => {
    ollamaReady = true;
    genResponse = ALL_THREE;
    const res = await api(srv.url, '/api/triality/next');
    const body = res.body as { picks: ({ slot: string; rationale: string; rationale_source: string } | null)[] };
    const live = body.picks.filter((p): p is { slot: string; rationale: string; rationale_source: string } => !!p);
    expect(genCalls.length).toBe(1); // one call for the whole request
    for (const p of live) {
      expect(p.rationale_source).toBe('ai');
      expect(Object.values(ALL_THREE)).toContain(p.rationale);
    }
  });

  it('GraphQL parity: camelCase field + SCREAMING enum, same source', async () => {
    ollamaReady = true;
    genResponse = ALL_THREE;
    const res = await fetch(`${srv.url}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ trialityNext { picks { slot rationale rationaleSource } } }` }),
    });
    const body = (await res.json()) as {
      errors?: unknown;
      data?: { trialityNext: { picks: ({ slot: string; rationale: string; rationaleSource: string } | null)[] } };
    };
    expect(body.errors).toBeUndefined();
    const live = body.data!.trialityNext.picks.filter(
      (p): p is { slot: string; rationale: string; rationaleSource: string } => !!p,
    );
    expect(live.length).toBeGreaterThan(0);
    for (const p of live) {
      expect(p.rationaleSource).toBe('AI');
      expect(Object.values(ALL_THREE)).toContain(p.rationale);
    }
  });

  it('GraphQL labels the deterministic line TEMPLATE', async () => {
    ollamaReady = false;
    const res = await fetch(`${srv.url}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ trialityNext { picks { rationale rationaleSource } } }` }),
    });
    const body = (await res.json()) as {
      data?: { trialityNext: { picks: ({ rationale: string; rationaleSource: string } | null)[] } };
    };
    const live = body.data!.trialityNext.picks.filter((p): p is { rationale: string; rationaleSource: string } => !!p);
    expect(live.length).toBeGreaterThan(0);
    for (const p of live) expect(p.rationaleSource).toBe('TEMPLATE');
  });
});
