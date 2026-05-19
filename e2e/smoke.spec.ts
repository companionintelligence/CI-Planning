/**
 * Smoke tests — verifies the app loads and basic navigation works.
 */
import { test, expect } from '@playwright/test';

test('homepage loads', async ({ page }) => {
  await page.goto('/');
  // The Svelte app should mount
  await expect(page.locator('body')).not.toBeEmpty();
  // Title should be visible
  await expect(page).toHaveTitle(/Companion|Planning|E2E/i);
});

test('API health: /api/config returns valid response', async ({ request }) => {
  const res = await request.get('/api/config');
  expect(res.ok()).toBe(true);
  const body = await res.json() as { title: string; port: number };
  expect(body).toHaveProperty('title');
  expect(body).toHaveProperty('port');
});

test('API health: /api/files returns file list', async ({ request }) => {
  const res = await request.get('/api/files');
  expect(res.ok()).toBe(true);
  const body = await res.json() as { files: unknown[] };
  expect(Array.isArray(body.files)).toBe(true);
  expect(body.files.length).toBeGreaterThan(0);
});

test('API health: /api/todos returns todos', async ({ request }) => {
  const res = await request.get('/api/todos');
  expect(res.ok()).toBe(true);
  const body = await res.json() as { todos: unknown[]; count: number };
  expect(body).toHaveProperty('count');
  expect(body.count).toBeGreaterThan(0);
});

test('API health: /api/stats returns aggregate counts', async ({ request }) => {
  const res = await request.get('/api/stats');
  expect(res.ok()).toBe(true);
  const body = await res.json() as Record<string, number>;
  expect(typeof body['todos_total']).toBe('number');
  expect(typeof body['files']).toBe('number');
});

test('manifest.webmanifest is present', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const body = await res.json() as { name: string };
  expect(body).toHaveProperty('name');
});
