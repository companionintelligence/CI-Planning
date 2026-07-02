/**
 * Phase M B4 — nudge-first escalation.
 *
 * The reactive reflow (B2) stays deterministic + LLM-free; on a BIG disruption it
 * surfaces ONE actionable nudge ('replan:suggested'). The LLM re-author runs ONLY
 * via POST /api/plan/reauthor (accept). Dismiss drops the nudge.
 *
 * `broadcast` is mocked to count SSE events. The reactive path uses fake timers
 * (the B2 debounce); the accept/dismiss HTTP tests use real timers.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/routes/sse.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/routes/sse.js')>();
  return { ...actual, broadcast: vi.fn() };
});

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { broadcast } from '../src/routes/sse.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';
import {
  isBigDisruption,
  requestReplan,
  outstandingSuggestion,
  clearSuggestion,
  _resetReplanState,
  type ReflowDiff,
} from '../src/engine/auto-defense.js';

const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-24';
const mockBroadcast = vi.mocked(broadcast);
const eventCount = (name: string): number => mockBroadcast.mock.calls.filter((c) => c[1] === name).length;

function insertTask(title: string, priority = 3, status = 'open'): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority, estimated_minutes) VALUES (uuid7(), ?, ?, ?, ?, 60) RETURNING id`)
      .get(title, OWNER, status, priority) as { id: string }
  ).id;
}
function stage(taskId: string): void {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
}
function seedDailyPlan(taskId: string, position: number): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, ?, 'deterministic')`)
    .run(OWNER, DATE, taskId, position);
}
function fullDayMeeting(): void {
  // Locked, non-auto meeting spanning the whole workday → zero free capacity.
  sqlite
    .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id) VALUES (uuid7(), 'All-day mtg', 'meeting', ?, ?, 1, 0, 'manual', 'planned', ?)`)
    .run(`${DATE}T09:00:00.000Z`, `${DATE}T18:00:00.000Z`, OWNER);
}
/**
 * Place `taskId` on an otherwise-open day, then fill the day so a subsequent reflow
 * can't re-place it. Models a genuine disruption: a COMMITTED placement gets knocked
 * out (gap-close reflow only re-packs already-placed work — it never intakes backlog).
 */
function placeThenFillDay(taskId: string): void {
  stage(taskId);
  placeFlightPlan(OWNER, { date: DATE }); // task holds a real slot on the open day...
  fullDayMeeting();                        // ...then the day fills up — reflow loses it
}
function setAutoDefense(on: boolean): void {
  sqlite.prepare(`UPDATE scheduling_prefs SET auto_defense_enabled = ? WHERE owner_id = ?`).run(on ? 1 : 0, OWNER);
}
function dailyPlan(): { task_id: string; position: number; source: string }[] {
  return sqlite
    .prepare(`SELECT task_id, position, source FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`)
    .all(OWNER, DATE) as { task_id: string; position: number; source: string }[];
}
const diffOf = (over: Partial<ReflowDiff> = {}): ReflowDiff => ({ moved: [], removed: [], added: [], unplaced: [], ...over });

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan`);
  sqlite.exec(`DELETE FROM daily_plan WHERE owner_id = '${OWNER}'`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', planning_mode = 'basic' WHERE owner_id = ?`).run(OWNER);
  _resetReplanState();
  mockBroadcast.mockClear();
});

describe('isBigDisruption', () => {
  it('true when a high-priority (P≤2) task is unplaced', () => {
    const p1 = insertTask('Important', 1);
    expect(isBigDisruption(diffOf({ unplaced: [p1] }))).toBe(true);
  });
  it('true when a high-priority task was removed (lost its slot)', () => {
    const p2 = insertTask('Also important', 2);
    expect(isBigDisruption(diffOf({ removed: [{ block_id: 'b', task_id: p2 }] }))).toBe(true);
  });
  it('false when only a low-priority task is at risk (routine backlog ≠ disruption)', () => {
    const p3 = insertTask('Whenever', 3);
    expect(isBigDisruption(diffOf({ unplaced: [p3] }))).toBe(false);
  });
  it('false for an empty diff', () => {
    expect(isBigDisruption(diffOf())).toBe(false);
  });
});

describe('reactive reflow → nudge (no LLM in the hot path)', () => {
  it('a big disruption raises exactly one replan:suggested, de-duped within the day', () => {
    vi.useFakeTimers();
    try {
      setAutoDefense(true);
      const p1 = insertTask('Crunch', 1);
      seedDailyPlan(p1, 0);
      placeThenFillDay(p1); // placed P1, then the day fills → P1 knocked out → big disruption

      requestReplan('task:updated', OWNER, DATE);
      vi.advanceTimersByTime(1500);
      expect(eventCount('replan:suggested')).toBe(1);
      expect(outstandingSuggestion(OWNER)?.date).toBe(DATE);

      // A second disruption the same day must NOT raise a second nudge.
      requestReplan('task:updated', OWNER, DATE);
      vi.advanceTimersByTime(1500);
      expect(eventCount('replan:suggested')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('nudge-first invariant: reflow surfaces a nudge but never re-authors daily_plan', () => {
    vi.useFakeTimers();
    try {
      setAutoDefense(true);
      const p1 = insertTask('Crunch', 1);
      seedDailyPlan(p1, 0);
      placeThenFillDay(p1);

      const before = dailyPlan();
      requestReplan('task:updated', OWNER, DATE);
      vi.advanceTimersByTime(1500);

      expect(eventCount('replan:suggested')).toBe(1);
      // The day plan is untouched by reflow — authoring only happens on accept.
      expect(dailyPlan()).toEqual(before);
      expect(dailyPlan()[0].source).toBe('deterministic');
    } finally {
      vi.useRealTimers();
    }
  });

  it('no nudge when only a low-priority task is at risk', () => {
    vi.useFakeTimers();
    try {
      setAutoDefense(true);
      const p3 = insertTask('Low', 3);
      seedDailyPlan(p3, 0);
      placeThenFillDay(p3);

      requestReplan('task:updated', OWNER, DATE);
      vi.advanceTimersByTime(1500);
      expect(eventCount('replan:suggested')).toBe(0);
      expect(outstandingSuggestion(OWNER)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /api/plan/reauthor (accept)', () => {
  it('force re-authors despite the author-once guard, clears the suggestion, refreshes', async () => {
    const p1 = insertTask('High', 1);
    const p3 = insertTask('Low', 3);
    stage(p1); stage(p3);
    // Seed a WRONG order: low-priority first. Without force, author-once would keep it.
    seedDailyPlan(p3, 0);
    seedDailyPlan(p1, 1);

    const res = await api(srv.url, '/api/plan/reauthor', { method: 'POST', json: { date: DATE } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Re-authored deterministically (Ollama down in CI): P1 leads now.
    const rows = dailyPlan();
    expect(rows[0].task_id).toBe(p1);
    expect(rows[0].source).toBe('deterministic'); // Ollama-down fallback, no throw
    expect(eventCount('schedule:done')).toBeGreaterThanOrEqual(1); // client refresh + B3 toast
  });
});

describe('POST /api/plan/reauthor/dismiss', () => {
  it('clears the outstanding suggestion and broadcasts replan:dismissed', async () => {
    // First raise a real suggestion via the reactive path.
    vi.useFakeTimers();
    setAutoDefense(true);
    const p1 = insertTask('Crunch', 1);
    seedDailyPlan(p1, 0);
    placeThenFillDay(p1);
    requestReplan('task:updated', OWNER, DATE);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();
    expect(outstandingSuggestion(OWNER)).toBeTruthy();

    const res = await api(srv.url, '/api/plan/reauthor/dismiss', { method: 'POST', json: { date: DATE } });
    expect(res.status).toBe(200);
    expect(outstandingSuggestion(OWNER)).toBeUndefined();
    expect(eventCount('replan:dismissed')).toBe(1);
  });
});

describe('restart-durable nudge (replan_suggestions table)', () => {
  it('persists the outstanding suggestion to the DB, so it survives a server restart', () => {
    vi.useFakeTimers();
    setAutoDefense(true);
    const p1 = insertTask('Crunch', 1);
    seedDailyPlan(p1, 0);
    placeThenFillDay(p1);
    requestReplan('task:updated', OWNER, DATE);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();

    // The suggestion is a row in replan_suggestions (not an in-memory Map) — a fresh
    // process reads it back via outstandingSuggestion, so a restart doesn't drop it.
    const row = sqlite
      .prepare(`SELECT date, summary, at_risk FROM replan_suggestions WHERE owner_id = ?`)
      .get(OWNER) as { date: string; summary: string; at_risk: number } | undefined;
    expect(row).toBeTruthy();
    expect(row!.date).toBe(DATE);
    expect(row!.at_risk).toBeGreaterThanOrEqual(1);
    expect(outstandingSuggestion(OWNER)).toEqual({ date: DATE, reason: 'task:updated', summary: row!.summary, atRisk: row!.at_risk });

    // Clearing removes the row.
    clearSuggestion(OWNER);
    expect(sqlite.prepare(`SELECT 1 FROM replan_suggestions WHERE owner_id = ?`).get(OWNER)).toBeUndefined();
  });
});

describe('GET /api/plan/suggestion (reload-durable nudge)', () => {
  it('returns null when there is no outstanding suggestion', async () => {
    const res = await api(srv.url, '/api/plan/suggestion');
    expect(res.status).toBe(200);
    expect(res.body.suggestion).toBeNull();
  });

  it('returns the outstanding suggestion after a big disruption, and null after dismiss', async () => {
    vi.useFakeTimers();
    setAutoDefense(true);
    const p1 = insertTask('Crunch', 1);
    seedDailyPlan(p1, 0);
    placeThenFillDay(p1);
    requestReplan('task:updated', OWNER, DATE);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();

    const got = await api(srv.url, '/api/plan/suggestion');
    expect(got.status).toBe(200);
    expect(got.body.suggestion).toBeTruthy();
    expect(got.body.suggestion.date).toBe(DATE);
    expect(got.body.suggestion.summary).toContain('priority task');

    await api(srv.url, '/api/plan/reauthor/dismiss', { method: 'POST', json: { date: DATE } });
    const after = await api(srv.url, '/api/plan/suggestion');
    expect(after.body.suggestion).toBeNull();
  });
});
