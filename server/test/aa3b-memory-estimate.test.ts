/**
 * AA3b — better default estimate for memory-drafted tasks (docs/AA3-smarter-autoplan.md).
 *
 *  - `memoryFallbackEstimate` ladder: memory-sourced median → global median → 30, each
 *    gated by CONFIDENCE_FLOOR samples.
 *  - Integration via `suggestFromMemory` (fixture mode): an event WITH a duration uses it
 *    (history ignored); an end-less event uses the history median.
 *
 * Fixture persons/events are relative-dated; the integration tests that need an end-less
 * event write their OWN graph.json to a temp dir via CP_MEMORY_FIXTURES_DIR.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, ALL_SCOPES, runWithOwner } from '../src/lib/context.js';
import { resetDb } from './helpers.js';
import { memoryFallbackEstimate, suggestFromMemory, MEMORY_SOURCE_KIND } from '../src/agents/memory-suggest.js';

const OWNER = SYSTEM_OWNER;

const SAVED = { url: process.env.CI_SERVER_URL, apiKey: process.env.CI_SERVER_API_KEY, mode: process.env.MEMORY_MODE, fx: process.env.CP_MEMORY_FIXTURES_DIR };
afterAll(() => {
  const r = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  r('CI_SERVER_URL', SAVED.url); r('CI_SERVER_API_KEY', SAVED.apiKey); r('MEMORY_MODE', SAVED.mode); r('CP_MEMORY_FIXTURES_DIR', SAVED.fx);
});

/** Insert a DONE task with a timed actual. `memory` → source_kind='memory'. */
function doneTask(actualMin: number, memory: boolean): void {
  sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, source_kind, estimated_minutes, actual_minutes) VALUES (uuid7(), 'done', ?, 'done', ?, 30, ?)`)
    .run(OWNER, memory ? MEMORY_SOURCE_KIND : 'manual', actualMin);
}

describe('AA3b memoryFallbackEstimate ladder', () => {
  beforeEach(() => { resetDb(); });

  it('no history ⇒ the 30m default', () => {
    expect(memoryFallbackEstimate(OWNER)).toBe(30);
  });

  it('below the sample floor (memory AND global) ⇒ 30m', () => {
    for (let i = 0; i < 4; i++) doneTask(90, false); // 4 < CONFIDENCE_FLOOR (5)
    expect(memoryFallbackEstimate(OWNER)).toBe(30);
  });

  it('≥ floor global, < floor memory ⇒ the global median', () => {
    [50, 60, 70, 80, 200].forEach((m) => doneTask(m, false)); // median 70
    doneTask(15, true); // one memory sample — below floor, ignored
    expect(memoryFallbackEstimate(OWNER)).toBe(70);
  });

  it('≥ floor memory ⇒ the memory-sourced median, even when the global median differs', () => {
    [45, 50, 55, 50, 50].forEach((m) => doneTask(m, true));  // memory median 50
    [120, 120, 120, 120, 120].forEach((m) => doneTask(m, false)); // global skewed high
    expect(memoryFallbackEstimate(OWNER)).toBe(50);
  });

  it('ignores un-timed done tasks (actual_minutes = 0)', () => {
    [50, 60, 70, 80, 90].forEach((m) => doneTask(m, false)); // median 70
    for (let i = 0; i < 10; i++) doneTask(0, false); // 0-actual → excluded, don't drag the median
    expect(memoryFallbackEstimate(OWNER)).toBe(70);
  });
});

describe('AA3b suggestFromMemory integration (fixture mode)', () => {
  function enablePull() { sqlite.prepare(`UPDATE scheduling_prefs SET memory_pull_enabled = 1 WHERE owner_id = ?`).run(OWNER); }
  function connectViaEnv() { process.env.CI_SERVER_URL = 'http://ci.local:3000'; process.env.CI_SERVER_API_KEY = 'test-key'; }
  const run = <T,>(fn: () => T | Promise<T>) => runWithOwner(OWNER, ALL_SCOPES, fn);
  function proposedEstimate(nameLike: string): number | null {
    const row = sqlite
      .prepare(`SELECT proposed_estimated_minutes AS m FROM possible_tasks WHERE proposed_owner_id = ? AND source_kind = ? AND raw_title LIKE ?`)
      .get(OWNER, MEMORY_SOURCE_KIND, `%${nameLike}%`) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  beforeEach(() => {
    resetDb();
    sqlite.exec(`DELETE FROM possible_tasks WHERE proposed_owner_id = '${OWNER}'`);
    delete process.env.CP_MEMORY_FIXTURES_DIR;
    delete process.env.MEMORY_MODE; // default fixture
    enablePull();
    connectViaEnv();
  });

  it('an event WITH a duration uses it and ignores the history median', async () => {
    // Seed a history median (90) that differs from the fixture events' real durations.
    [90, 90, 90, 90, 90].forEach((m) => doneTask(m, true));
    // Default fixture: "Quarterly planning review" runs now+20h→now+21h = 60m.
    await run(() => suggestFromMemory({ polish: false }));
    expect(proposedEstimate('Quarterly planning review')).toBe(60); // event duration, NOT 90
  });

  it('an end-less event uses the history median (not the 30m default)', async () => {
    [45, 50, 55, 50, 50].forEach((m) => doneTask(m, true)); // memory median 50
    // Custom fixture: one event with a start (inside the 48h window) and NO end.
    const dir = mkdtempSync(join(tmpdir(), 'aa3b-fx-'));
    writeFileSync(
      join(dir, 'graph.json'),
      JSON.stringify({ nodes: [{ entity_id: 'e-standup', entity_type: 'event', name: 'Standup', properties: { start_time: 'now+2h' } }], links: [] }),
    );
    process.env.CP_MEMORY_FIXTURES_DIR = dir;
    try {
      await run(() => suggestFromMemory({ polish: false }));
      expect(proposedEstimate('Standup')).toBe(50); // history median, not 30
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
