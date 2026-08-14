/**
 * The ONE degrade contract (`llmOrNull`) and the ONE availability predicate (`isReady`).
 *
 * Before this, six hand-rolled shapes answered "Ollama might be down" — four of them
 * `catch {}` blocks that also swallowed genuine bugs — and two disagreeing predicates
 * answered "can we call a model". The tests here pin both halves of the contract:
 *
 *  1. `llmOrNull` degrades on exactly two failures (`OllamaUnavailable`, `LlmParseError`)
 *     and RE-THROWS everything else, so a `TypeError` in our own code is never dressed
 *     up as "the model had nothing to say".
 *  2. `isReady` gates on `ready`, not `available`. A reachable Ollama with nothing pulled
 *     is a green light with nothing behind it: the old `isAvailable` gate let the whole
 *     §A0 generate→judge→revise loop run against an install that could not serve one
 *     call. The regression test counts `/api/generate` requests — landing on the
 *     deterministic order is NOT enough, since the old code landed there too, the long
 *     way around, after burning the loop's call budget on failures.
 *
 * Ollama is NOT module-mocked here on purpose: `isReady` → `status()` → `/api/tags` is
 * the exact path under test, so only the network is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  llmOrNull,
  parseJsonLoose,
  generate,
  OllamaUnavailable,
  LlmParseError,
  isReady,
} from '../src/mcp/ollama.js';
import { setInstalledModels } from '../src/lib/models.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { authorPlanOrder, parseInstruction, InstructError } from '../src/agents/plan.js';
import { resetDb } from './helpers.js';

// ── 1. the degrade contract ──────────────────────────────────────────────────

describe('llmOrNull', () => {
  it('returns null when Ollama is unavailable', async () => {
    const r = await llmOrNull('t', async () => {
      throw new OllamaUnavailable("Model 'llama3.2' is not installed in Ollama.");
    });
    expect(r).toBeNull();
  });

  it('returns null when the model reply cannot be parsed', async () => {
    const r = await llmOrNull('t', async () => {
      throw new LlmParseError('Could not parse JSON from model output: <html>');
    });
    expect(r).toBeNull();
  });

  it('RE-THROWS a TypeError — the guard against swallowing genuine bugs', async () => {
    // The whole point of the class check. A bare `catch {}` turned this into `[]`/`{}`
    // at six sites, which is indistinguishable from a model that answered with nothing.
    await expect(
      llmOrNull('t', async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'tags')");
      }),
    ).rejects.toThrow(TypeError);
  });

  it('passes a success through untouched', async () => {
    expect(await llmOrNull('t', async () => ({ tags: ['work'] }))).toEqual({ tags: ['work'] });
    expect(await llmOrNull('t', async () => null)).toBeNull(); // a genuine null is not special-cased
  });
});

describe('parseJsonLoose', () => {
  it('throws LlmParseError on unparseable output', () => {
    expect(() => parseJsonLoose('not json at all')).toThrow(LlmParseError);
  });

  it('the error still satisfies instanceof Error, so broad catches are unaffected', () => {
    // The typed class is additive: it exists so `llmOrNull` can TELL a parse failure from
    // a bug, not to change what any pre-existing `catch (err)` sees.
    try {
      parseJsonLoose('not json at all');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('LlmParseError');
    }
  });

  it('still parses everything it parsed before', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
});

describe('a 200 with a non-JSON body is a TRANSPORT failure, not a bug', () => {
  // The degrade contract's sharp edge. `llmOrNull` re-throws anything that is not
  // OllamaUnavailable/LlmParseError, so if `generate()` let a raw SyntaxError out of
  // `res.json()`, a proxy or tunnel answering 200 with an HTML error page would turn
  // what has always been a silent, correct degrade (suggestTags → []) into a 500.
  // Classifying it as OllamaUnavailable — not LlmParseError, which means the MODEL
  // misbehaved — is what keeps that degrade intact.
  const realFetchLocal = globalThis.fetch;
  afterEach(() => { vi.stubGlobal('fetch', realFetchLocal); });

  it('surfaces as OllamaUnavailable, so llmOrNull degrades instead of throwing', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }));

    await expect(generate('hi', { model: 'x' })).rejects.toBeInstanceOf(OllamaUnavailable);
    expect(await llmOrNull('probe', () => generate('hi', { model: 'x' }))).toBeNull();
  });
});

// ── 2. the availability predicate ────────────────────────────────────────────

const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-24';

/** Requests the stub saw, so "did it try to call the model" is directly assertable. */
let requested: string[] = [];
const realFetch = globalThis.fetch;

/**
 * A REACHABLE Ollama with NOTHING PULLED — the install this ticket exists for.
 * `/api/tags` answers 200 (so `available` is true), and `setInstalledModels([])` makes
 * every effective model missing (so `ready` is false). `/api/generate` answers, and is
 * counted: reaching it at all is the bug.
 */
function stubReachableButEmptyOllama(): void {
  requested = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    if (url.includes('/api/tags')) {
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/generate')) {
      return new Response(JSON.stringify({ response: '[0,1]' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  });
  setInstalledModels([]); // reachable, nothing pulled
}

const generateCalls = () => requested.filter((u) => u.includes('/api/generate')).length;

function insertTask(title: string): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES (uuid7(), ?, ?, 'open', 3) RETURNING id`)
      .get(title, OWNER) as { id: string }
  ).id;
}
function stage(taskId: string, position: number): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`)
    .run(OWNER, taskId, position);
}

describe('isReady gates on ready, not available', () => {
  beforeEach(() => {
    resetDb();
    sqlite.exec(`DELETE FROM flight_plan`);
    sqlite.exec(`DELETE FROM daily_plan WHERE owner_id = '${OWNER}'`);
    sqlite.prepare(`UPDATE scheduling_prefs SET planning_mode = 'smart', timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
    stubReachableButEmptyOllama();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setInstalledModels(null); // back to "unknown" — the state every other suite assumes
  });

  it('answers false for a reachable Ollama with no pulled model', async () => {
    expect(await isReady()).toBe(false);
    expect(requested.some((u) => u.includes('/api/tags'))).toBe(true); // it really did probe
  });

  it('authorPlanOrder: smart mode authors deterministically and makes ZERO generate calls', async () => {
    const a = insertTask('A');
    const b = insertTask('B');
    stage(a, 0);
    stage(b, 1);

    await expect(authorPlanOrder(OWNER, DATE)).resolves.toBe('deterministic');

    // The regression assertion. Under the old `isAvailable` gate this was 1+: the loop
    // ran, every call failed, and the day landed deterministic anyway — so the SOURCE
    // alone never caught the bug. Zero calls is the only proof the gate held.
    expect(generateCalls()).toBe(0);

    const rows = sqlite
      .prepare(`SELECT source, rationale FROM daily_plan WHERE owner_id = ? AND date = ?`)
      .all(OWNER, DATE) as { source: string; rationale: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === 'deterministic')).toBe(true);
    expect(rows.every((r) => r.rationale === null)).toBe(true);
  });

  it("parseInstruction: 503s cleanly with 'AI is unavailable' instead of failing deeper", async () => {
    // The user-visible half of the predicate swap. Before, this gate passed (Ollama
    // answered /api/tags) and the call underneath failed with a model-not-found error;
    // now the NL-instruct surface returns the same 503 the client's own gate implies.
    await expect(parseInstruction(OWNER, DATE, 'gym at 7')).rejects.toThrow(InstructError);
    await expect(parseInstruction(OWNER, DATE, 'gym at 7')).rejects.toMatchObject({
      code: 'unavailable',
      message: 'AI is unavailable',
    });
    expect(generateCalls()).toBe(0);
  });
});
