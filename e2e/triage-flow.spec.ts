/**
 * LLM endpoint smoke tests. These assert the endpoints are wired and degrade
 * gracefully — they do NOT require a working Ollama.
 *
 * Note: the *server* makes the Ollama fetch, so browser-level page.route() can't
 * intercept it. Instead we assert the contract: 200 (model produced output) or
 * 503 (Ollama unreachable / model errored / timed out). The server maps every
 * LLM-layer failure to 503 (see respondLlmError in http.ts), so 500 here would
 * mean a genuine bug, not a flaky model.
 */
import { test, expect } from '@playwright/test';

test('POST /api/llm/triage returns structured actions or 503', async ({ request }) => {
  const res = await request.post('/api/llm/triage', { data: { limit: 5 } });
  expect([200, 503]).toContain(res.status());
  if (res.status() === 200) {
    const body = await res.json() as { actions?: unknown[] };
    expect(body).toHaveProperty('actions');
  }
});

test('GET /api/llm/status reflects Ollama availability', async ({ request }) => {
  const res = await request.get('/api/llm/status');
  expect(res.ok()).toBe(true);
  const body = await res.json() as { available: boolean };
  expect(typeof body.available).toBe('boolean');
});

test('POST /api/llm/extract returns todos array or 503', async ({ request }) => {
  const res = await request.post('/api/llm/extract', {
    data: { text: 'Tomorrow I need to buy milk and call Alice about the project.' },
  });
  expect([200, 503]).toContain(res.status());
  if (res.status() === 200) {
    const body = await res.json() as { todos: unknown[] };
    expect(Array.isArray(body.todos)).toBe(true);
  }
});

test('POST /api/llm/archive returns proposals array or 503', async ({ request }) => {
  const res = await request.post('/api/llm/archive', { data: {} });
  expect([200, 503]).toContain(res.status());
  if (res.status() === 200) {
    const body = await res.json() as { proposals: unknown[] };
    expect(Array.isArray(body.proposals)).toBe(true);
  }
});
