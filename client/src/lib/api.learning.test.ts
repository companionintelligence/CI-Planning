import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError } from './api.js';
import { LEARNING_LIMITS } from './learning-stats.js';

/**
 * Settings → Learning: the seven calls. Pins the method, the URL and the limit of each, that
 * a failure carries the server's text and the HTTP status (the card tells "offline" from
 * "older server" from "failed" by that status, and the reset control tells a 403 from the
 * rest), and that there is deliberately no way to clear the plan-loop stats.
 */

const fetchMock = vi.fn();

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok({}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return { url, method: init.method };
};

describe('api.learning reads', () => {
  it('classificationAccuracy GETs /api/classification/accuracy?limit=24 by default', async () => {
    await api.learning.classificationAccuracy();
    expect(lastCall()).toEqual({ url: '/api/classification/accuracy?limit=24', method: 'GET' });
  });

  it('dismissalTrend GETs /api/dismissal-learning/trend?limit=12 by default', async () => {
    await api.learning.dismissalTrend();
    expect(lastCall()).toEqual({ url: '/api/dismissal-learning/trend?limit=12', method: 'GET' });
  });

  it('placementSurvival GETs /api/placement/survival?limit=12 by default', async () => {
    await api.learning.placementSurvival();
    expect(lastCall()).toEqual({ url: '/api/placement/survival?limit=12', method: 'GET' });
  });

  it('planLoopTrend GETs /api/plan-loop/trend?limit=24 by default', async () => {
    await api.learning.planLoopTrend();
    expect(lastCall()).toEqual({ url: '/api/plan-loop/trend?limit=24', method: 'GET' });
  });

  it('the defaults are the LEARNING_LIMITS the tiles pass, so the two cannot drift', async () => {
    await api.learning.classificationAccuracy();
    await api.learning.dismissalTrend();
    await api.learning.placementSurvival();
    await api.learning.planLoopTrend();
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      `/api/classification/accuracy?limit=${LEARNING_LIMITS.classification}`,
      `/api/dismissal-learning/trend?limit=${LEARNING_LIMITS.dismissal}`,
      `/api/placement/survival?limit=${LEARNING_LIMITS.placement}`,
      `/api/plan-loop/trend?limit=${LEARNING_LIMITS.planLoop}`,
    ]);
  });

  it('passes a custom limit through', async () => {
    await api.learning.classificationAccuracy(50);
    expect(lastCall().url).toBe('/api/classification/accuracy?limit=50');
    await api.learning.dismissalTrend(90);
    expect(lastCall().url).toBe('/api/dismissal-learning/trend?limit=90');
    await api.learning.placementSurvival(4);
    expect(lastCall().url).toBe('/api/placement/survival?limit=4');
    await api.learning.planLoopTrend(100);
    expect(lastCall().url).toBe('/api/plan-loop/trend?limit=100');
  });

  it('sends no body and returns the parsed response untouched (nulls stay null)', async () => {
    const body = {
      fields: ['category', 'motivation'],
      runs: [{ field: 'category', computed_date: '2026-10-26', held_out: 0, correct: 0, accuracy: null }],
    };
    fetchMock.mockResolvedValue(ok(body));
    const res = await api.learning.classificationAccuracy();
    expect(res).toEqual(body);
    expect(res.runs[0].accuracy).toBeNull();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });
});

describe('api.learning clears', () => {
  it('resetClassification DELETEs /api/classification/exemplars', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, cleared: 7 }));
    await expect(api.learning.resetClassification()).resolves.toEqual({ ok: true, cleared: 7 });
    expect(lastCall()).toEqual({ url: '/api/classification/exemplars', method: 'DELETE' });
  });

  it('resetDismissal DELETEs /api/dismissal-learning/exemplars', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, cleared: 0 }));
    await expect(api.learning.resetDismissal()).resolves.toEqual({ ok: true, cleared: 0 });
    expect(lastCall()).toEqual({ url: '/api/dismissal-learning/exemplars', method: 'DELETE' });
  });

  it('resetPlacement DELETEs /api/placement/preferences', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, cleared: 2 }));
    await expect(api.learning.resetPlacement()).resolves.toEqual({ ok: true, cleared: 2 });
    expect(lastCall()).toEqual({ url: '/api/placement/preferences', method: 'DELETE' });
  });

  it('there is no way to clear the plan-loop stats, by design', () => {
    expect('resetPlanLoop' in api.learning).toBe(false);
    // Exactly seven calls: four reads and three clears. Nothing else was added.
    expect(Object.keys(api.learning).sort()).toEqual([
      'classificationAccuracy',
      'dismissalTrend',
      'placementSurvival',
      'planLoopTrend',
      'resetClassification',
      'resetDismissal',
      'resetPlacement',
    ]);
  });
});

describe('api.learning failures', () => {
  const reads: Array<[string, () => Promise<unknown>]> = [
    ['classificationAccuracy', () => api.learning.classificationAccuracy()],
    ['dismissalTrend', () => api.learning.dismissalTrend()],
    ['placementSurvival', () => api.learning.placementSurvival()],
    ['planLoopTrend', () => api.learning.planLoopTrend()],
  ];

  it.each(reads)('%s: a non-OK response rejects with the server text and the status', async (_name, call) => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'database is locked' }),
    });
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('database is locked');
    expect((err as ApiError).status).toBe(500);
  });

  it.each(reads)('%s: a 404 (older server) carries status 404', async (_name, call) => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) });
    const err = (await call().then(
      () => null,
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    // No body to read: falls back to the HTTP status text rather than an empty message.
    expect(err.message).toBe('Not Found');
  });

  it.each(reads)('%s: a request that never gets an answer carries status 0 (offline)', async (_name, call) => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = (await call().then(
      () => null,
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it('a viewer clearing gets 403 {error:"forbidden"} with status 403 on every clear', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: 'forbidden' }),
    });
    for (const call of [
      () => api.learning.resetClassification(),
      () => api.learning.resetDismissal(),
      () => api.learning.resetPlacement(),
    ]) {
      const err = (await call().then(
        () => null,
        (e: unknown) => e,
      )) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toBe('forbidden');
      expect(err.status).toBe(403);
    }
  });
});
