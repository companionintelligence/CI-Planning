import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, ALL_SCOPES, runWithOwner } from '../src/lib/context.js';
import { trialityNext } from '../src/services/triality.js';
import { embed, OllamaUnavailable } from '../src/mcp/ollama.js';
import { config } from '../src/lib/config.js';
import { resetDb } from './helpers.js';

/**
 * The novelty stage's wall-clock budget must SHED the work it walks away from.
 *
 * Racing the stage against a deadline bounded the caller's latency but not the load:
 * every expired budget left up to 25 centroid embeddings plus one per candidate still
 * running against Ollama, to their own per-call ceilings, for results already discarded.
 * That is a feedback loop rather than mere waste — a busy Ollama blows the budget more
 * often, and each blown budget adds another pile of orphaned embeddings keeping it busy.
 *
 * Fixture style follows triality-engine.test.ts: raw sqlite inserts, frozen NOW,
 * injected embedFn.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function insertTask(title: string, o: { status?: string; completedAt?: string; mood?: string } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, completed_at, completion_mood, priority)
       VALUES (uuid7(), ?, ?, ?, 30, ?, ?, 3)`,
    )
    .run(title, OWNER, o.status ?? 'open', o.completedAt ?? null, o.mood ?? null);
}

/**
 * Enough history to clear the refusal floor (10 confirmed completions) AND to build a
 * centroid (the stage needs 5+ completed titles in the window), plus open candidates for
 * it to score. Below any of those the stage returns categorical before embedding at all,
 * and the test would pass without ever exercising what it claims to.
 */
function seedScorableOwner(): void {
  for (let i = 0; i < 12; i++) {
    insertTask(`done-${i}`, { status: 'done', completedAt: daysAgo(1 + (i % 30)), mood: 'flat' });
  }
  for (const t of ['write report', 'call plumber', 'sketch garden plan']) insertTask(t);
}

beforeEach(() => resetDb());

describe('novelty budget cancellation', () => {
  it('aborts every embedding still in flight when the budget expires', { timeout: 20_000 }, async () => {
    seedScorableOwner();

    const handed: AbortSignal[] = [];
    let aborted = 0;
    // Never resolves on its own — the only way out is the budget cancelling it.
    const hang = (_text: string, signal?: AbortSignal) =>
      new Promise<number[]>((_resolve, reject) => {
        expect(signal).toBeDefined();
        handed.push(signal!);
        signal!.addEventListener('abort', () => {
          aborted++;
          reject(new OllamaUnavailable('cancelled'));
        });
      });

    const res = await trialityNext(OWNER, NOW, { embedFn: hang });

    // The stage really did reach the embedder…
    expect(handed.length).toBeGreaterThan(0);
    // …and not one of those calls was left running once the stage gave up.
    expect(aborted).toBe(handed.length);
    expect(handed.every((s) => s.aborted)).toBe(true);
    // The request still answered — cancelling sheds load, it does not fail the caller.
    expect(res.refused).toBeUndefined();
  });

  it('aborts the siblings when one embedding fails, without waiting out the budget', { timeout: 20_000 }, async () => {
    seedScorableOwner();

    const handed: AbortSignal[] = [];
    let first = true;
    const oneBadApple = (_text: string, signal?: AbortSignal) =>
      new Promise<number[]>((_resolve, reject) => {
        handed.push(signal!);
        if (first) {
          first = false;
          // Promise.all rejects here and settles the race immediately, while every
          // sibling is still in flight — the fast-fail path, which leaked too.
          reject(new OllamaUnavailable('embedder fell over'));
          return;
        }
        signal!.addEventListener('abort', () => reject(new OllamaUnavailable('cancelled')));
      });

    const started = Date.now();
    const res = await trialityNext(OWNER, NOW, { embedFn: oneBadApple });
    const elapsed = Date.now() - started;

    expect(handed.length).toBeGreaterThan(1);
    expect(handed.every((s) => s.aborted)).toBe(true);
    // Well inside the 4s stage budget: the failure propagated instead of the siblings
    // being left to hold the stage open until the deadline.
    expect(elapsed).toBeLessThan(3_000);
    expect(res.refused).toBeUndefined();
  });
});

describe('ollama.embed honours a caller signal', () => {
  // A server that accepts the connection and never answers, so the only thing that can
  // end the request is one of the two deadlines.
  let server: Server;
  let sockets: Socket[] = [];
  let savedUrl: string;

  beforeEach(async () => {
    sockets = [];
    server = createServer(() => { /* deliberately silent */ });
    server.on('connection', (s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    savedUrl = config.ollamaUrl;
    config.ollamaUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    for (const s of sockets) s.destroy();
    server?.close();
  });

  it('cancels the in-flight request and says so, rather than reporting a timeout', async () => {
    const budget = new AbortController();
    // A 60s per-call ceiling: if the caller signal were ignored, this test would hang
    // until vitest killed it rather than returning in ~50ms.
    const p = runWithOwner(OWNER, ALL_SCOPES, () => embed('some text', 60_000, budget.signal));
    setTimeout(() => budget.abort(), 50);

    await expect(p).rejects.toThrow(OllamaUnavailable);
    // The message must name the real cause — "timed out after 60000ms" would send
    // whoever reads the log hunting a slow model that was never the problem.
    await expect(p).rejects.toThrow(/cancelled/i);

    for (const s of sockets) s.destroy();
    config.ollamaUrl = savedUrl;
  });
});
