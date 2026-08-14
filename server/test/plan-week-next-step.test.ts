import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return { ...mod, generate: vi.fn() };
});

import { sqlite } from '../src/db/index.js';
// OllamaUnavailable is what the real `generate` seam throws for a transport failure —
// the doubles below throw it so "Ollama down" means here what it means in production.
import { generate, OllamaUnavailable } from '../src/mcp/ollama.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { planWeekNextStep, type PlanWeekNextStepResult } from '../src/services/plan-week.js';

/**
 * FTUE · T7 (#343) — the Plan-Week hybrid follow-up layer.
 *
 * `generate` is mocked exactly like render-copy.test.ts; the gate itself is exercised
 * indirectly here (already covered directly there) — these tests pin planWeekNextStep's
 * own contract: short-circuit on a fallback question, sequential distinct options on a
 * model question, and that the route never 503s.
 */

const mockGenerate = generate as unknown as ReturnType<typeof vi.fn>;
const OWNER = SYSTEM_OWNER;

function historyCount(surface: string): number {
  return (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM copy_history WHERE owner_id = ? AND surface = ?`)
    .get(OWNER, surface) as { n: number }).n;
}

const INPUT = {
  branch: 'schedule_tasks',
  context: { openCount: 5 },
  fallbackQuestion: 'Which task should I find time for?',
  fallbackOptions: ['Ship the beta', 'Close hiring', 'Cut scope'],
};

beforeEach(() => {
  resetDb();
  mockGenerate.mockReset();
});

describe('planWeekNextStep (service)', () => {
  it('model renders a clean question + 3 distinct options ⇒ source: model, and both surfaces gain history rows', async () => {
    mockGenerate
      .mockResolvedValueOnce('Which objective matters most this week?')
      .mockResolvedValueOnce('Ship the beta')
      .mockResolvedValueOnce('Close the hiring loop')
      .mockResolvedValueOnce('Trim project scope');

    const res = await planWeekNextStep(INPUT);

    expect(res.source).toBe('model');
    expect(res.question).toBe('Which objective matters most this week?');
    expect(res.options).toHaveLength(3);
    expect(new Set(res.options).size).toBe(3); // distinct — the anti-repetition window did its job

    expect(historyCount('plan_week_followup')).toBe(1);
    expect(historyCount('plan_week_option')).toBe(3);
  });

  it('Ollama down ⇒ short-circuits to the fallback with zero option-level calls', async () => {
    mockGenerate.mockRejectedValue(new OllamaUnavailable('ECONNREFUSED'));

    const res = await planWeekNextStep(INPUT);

    expect(res).toEqual<PlanWeekNextStepResult>({
      question: INPUT.fallbackQuestion,
      options: INPUT.fallbackOptions,
      source: 'fallback',
    });
    // Exactly one attempt — for the question surface only; no per-option calls follow.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('the model keeps emitting banned copy ⇒ the question falls back, and no options are rendered', async () => {
    mockGenerate.mockResolvedValue("Let's just simplify this.");

    const res = await planWeekNextStep(INPUT);

    expect(res.source).toBe('fallback');
    expect(res.question).toBe(INPUT.fallbackQuestion);
    expect(res.options).toEqual(INPUT.fallbackOptions);
    // Both regeneration attempts were spent on the question; no option surface calls.
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/plan-week/next-step (route)', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  const post = (body: unknown) =>
    api<PlanWeekNextStepResult>(server.url, '/api/plan-week/next-step', { method: 'POST', json: body });

  it('200s with the { question, options[3], source } shape on a valid body', async () => {
    mockGenerate
      .mockResolvedValueOnce('Which objective matters most this week?')
      .mockResolvedValueOnce('Ship the beta')
      .mockResolvedValueOnce('Close the hiring loop')
      .mockResolvedValueOnce('Trim project scope');

    const r = await post(INPUT);

    expect(r.status).toBe(200);
    expect(r.body.source).toBe('model');
    expect(r.body.options).toHaveLength(3);
  });

  it('never 503s — Ollama down still returns 200 with source: fallback', async () => {
    mockGenerate.mockRejectedValue(new OllamaUnavailable('ECONNREFUSED'));

    const r = await post(INPUT);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      question: INPUT.fallbackQuestion,
      options: INPUT.fallbackOptions,
      source: 'fallback',
    });
  });

  it('422s when fallbackOptions is not exactly 3 non-empty strings, without calling the model', async () => {
    const r = await post({ ...INPUT, fallbackOptions: ['only one'] });
    expect(r.status).toBe(422);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('422s when fallbackQuestion is blank, without calling the model', async () => {
    const r = await post({ ...INPUT, fallbackQuestion: '   ' });
    expect(r.status).toBe(422);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
