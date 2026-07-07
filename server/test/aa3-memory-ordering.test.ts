/**
 * AA3a — memory-aware ordering (docs/AA3-smarter-autoplan.md).
 *
 * Two layers:
 *  - PURE matcher (memoryTerms + memoryRelatedTasks): term extraction and relatedness,
 *    no DB / no network.
 *  - authorPlanOrder integration in FIXTURE mode: flag ON + connector available ⇒ a
 *    memory-related task is authored earlier; flag OFF / unavailable ⇒ the daily_plan
 *    order is byte-identical to the pre-AA3a deterministic order.
 *
 * Fixture graph persons are UNDATED, so person-token relatedness is date-stable (a
 * day-window graphData still returns them) — the integration test keys on person
 * "Maya Lindqvist" and never on the relative-dated events (the time-bomb-date gotcha).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb } from './helpers.js';
import {
  memoryTerms,
  memoryRelatedTasks,
  deterministicIndices,
  authorPlanOrder,
  type PlanTask,
} from '../src/agents/plan.js';
import type { MemoryGraph } from '../src/connectors/memory.js';

const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-24';

const SAVED = { kek: process.env.CP_KEK_B64, url: process.env.CI_SERVER_URL, apiKey: process.env.CI_SERVER_API_KEY, mode: process.env.MEMORY_MODE };
beforeAll(() => { process.env.CP_KEK_B64 = Buffer.alloc(32, 7).toString('base64'); });
afterAll(() => {
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore('CP_KEK_B64', SAVED.kek); restore('CI_SERVER_URL', SAVED.url); restore('CI_SERVER_API_KEY', SAVED.apiKey); restore('MEMORY_MODE', SAVED.mode);
});

function pt(id: string, title: string, tags: string[] = [], priority = 3, due: string | null = null): PlanTask {
  return { task_id: id, title, priority, due_at: due, estimated_minutes: 30, tags };
}
const graph = (nodes: { id: string; entityType: string; name: string; properties?: Record<string, unknown> }[]): MemoryGraph => ({
  nodes: nodes.map((n) => ({ id: n.id, entityType: n.entityType, name: n.name, description: null, properties: n.properties ?? {} })),
  links: [],
});

// ─── Pure matcher ────────────────────────────────────────────────────────────

describe('AA3a memoryTerms + memoryRelatedTasks (pure)', () => {
  it('extracts person/event name tokens (≥4), event phrases, and event tags', () => {
    const t = memoryTerms(graph([
      { id: 'p1', entityType: 'person', name: 'Maya Lindqvist' },
      { id: 'e1', entityType: 'event', name: 'Dinner with Maya', properties: { tag: 'Home' } },
      { id: 'x1', entityType: 'place', name: 'Reykjavik' }, // ignored (not person/event)
    ]));
    expect([...t.tokens].sort()).toEqual(['dinner', 'lindqvist', 'maya', 'with']); // 'with' is 4 chars
    expect(t.phrases).toEqual(['dinner with maya']);
    expect([...t.tags]).toEqual(['home']);
  });

  it('relates a task by person token, by event phrase, and by tag — and skips unrelated', () => {
    const terms = memoryTerms(graph([
      { id: 'p1', entityType: 'person', name: 'Maya Lindqvist' },
      { id: 'e1', entityType: 'event', name: 'Quarterly planning review', properties: { tag: 'Work' } },
    ]));
    const tasks = [
      pt('a', 'Prep notes for Lindqvist'),            // person token
      pt('b', 'Quarterly planning review'),           // event phrase
      pt('c', 'Weekly sync', ['Work']),               // event tag on a task tag
      pt('d', 'Buy groceries'),                        // unrelated
    ];
    const related = memoryRelatedTasks(tasks, terms);
    expect([...related].sort()).toEqual(['a', 'b', 'c']);
    expect(related.has('d')).toBe(false);
  });

  it('empty terms ⇒ empty related set (identical-when-unavailable invariant)', () => {
    const terms = memoryTerms(graph([]));
    expect(memoryRelatedTasks([pt('a', 'Anything')], terms).size).toBe(0);
  });

  it('short/common tokens (<4) do not match', () => {
    const terms = memoryTerms(graph([{ id: 'p', entityType: 'person', name: 'Al Bo' }])); // both tokens <4
    expect(memoryRelatedTasks([pt('a', 'Call Al about Bo')], terms).size).toBe(0);
  });
});

// ─── deterministicIndices band position ────────────────────────────────────────

describe('AA3a deterministicIndices memory band', () => {
  const tasks = [
    pt('early-due', 'Taxes', [], 3, '2026-06-25'), // earlier deadline, NOT related
    pt('related', 'Call Maya', [], 3, '2026-12-31'), // later deadline, related
  ];

  it('ranks a memory-related task ahead of an earlier-due unrelated one', () => {
    const order = deterministicIndices(tasks, null, 'overdue', new Set(['related']));
    expect(tasks[order[0]].task_id).toBe('related'); // memory band beats deadline
  });

  it('is byte-identical to the no-memory order when the set is empty', () => {
    const withEmpty = deterministicIndices(tasks, null, 'overdue', new Set());
    const without = deterministicIndices(tasks, null, 'overdue');
    expect(withEmpty).toEqual(without);
    expect(tasks[withEmpty[0]].task_id).toBe('early-due'); // deadline wins again
  });
});

// ─── authorPlanOrder integration (fixture mode) ────────────────────────────────

describe('AA3a authorPlanOrder integration (fixture graph)', () => {
  function insertTask(id: string, title: string, priority = 3, due: string | null = null): void {
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority, due_at, estimated_minutes) VALUES (?, ?, ?, 'open', ?, ?, 30)`)
      .run(id, title, OWNER, priority, due);
  }
  function stage(id: string, position: number): void {
    sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`).run(OWNER, id, position);
  }
  function plannedOrder(): string[] {
    return (sqlite.prepare(`SELECT task_id FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`).all(OWNER, DATE) as { task_id: string }[]).map((r) => r.task_id);
  }
  function connectViaEnv(): void { process.env.CI_SERVER_URL = 'http://ci.local:3000'; process.env.CI_SERVER_API_KEY = 'test-key'; }

  beforeEach(() => {
    resetDb(); // memory_pull_enabled = 0, planning_mode basic, timezone UTC, clears connection_tokens
    sqlite.exec(`DELETE FROM flight_plan`);
    sqlite.exec(`DELETE FROM daily_plan WHERE owner_id = '${OWNER}'`);
    delete process.env.CI_SERVER_URL; delete process.env.CI_SERVER_API_KEY; delete process.env.MEMORY_MODE; // default fixture
    // 'related' relates to fixture person "Maya Lindqvist"; 'other' matches nothing.
    // Same priority; 'other' has the EARLIER deadline so, without memory, it leads.
    insertTask('t-related', 'Prep for Lindqvist', 3, '2026-12-31');
    insertTask('t-other', 'File taxes', 3, '2026-06-25');
    stage('t-related', 0);
    stage('t-other', 1);
  });

  it('flag ON + connector available ⇒ the memory-related task is authored earlier', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET memory_pull_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    connectViaEnv(); // creds resolve; MEMORY_MODE default fixture ⇒ offline graph.json

    await authorPlanOrder(OWNER, DATE);

    expect(plannedOrder()[0]).toBe('t-related'); // memory band beat the earlier deadline
  });

  it('flag OFF ⇒ daily_plan order is byte-identical to the deadline-first order', async () => {
    connectViaEnv(); // creds resolve, but the pull flag stays 0 (resetDb default)
    await authorPlanOrder(OWNER, DATE);
    expect(plannedOrder()).toEqual(['t-other', 't-related']); // earlier deadline leads; no memory effect
  });

  it('flag ON but no connector creds ⇒ identical to flag-off (unavailable degrade)', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET memory_pull_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    // No CI_SERVER_URL and no stored connection ⇒ memoryConnectorAvailable is false.
    await authorPlanOrder(OWNER, DATE);
    expect(plannedOrder()).toEqual(['t-other', 't-related']);
  });
});
