import { test, expect } from '@playwright/test';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;

test('task details save a timestamped note and completion', async ({ page }, testInfo) => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
  const data = new OwnerFixtures(page.request, testInfo.testId);

  try {
    await signInLocal(page, url);
    const task = await data.createTask({
      title: `E2E task ${testInfo.testId}`,
      estimated_minutes: 25,
      priority: 3,
    });
    const noteBody = `Browser test note ${testInfo.testId}`;

    // Task IDs are linkable by design, so this opens the real task drawer without
    // relying on the compact card's expansion affordance.
    await page.goto(`${url}/tasks?task=${encodeURIComponent(task.id)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-app-shell]')).toBeVisible();
    const card = page.locator('.task-card').filter({ hasText: task.title });
    await expect(card).toBeVisible();

    const drawer = page.locator('.details-drawer');
    await expect(drawer).toContainText(task.title);
    await expect(drawer.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await expect(drawer.getByRole('group', { name: 'Task note actions' })).toBeVisible();
    await drawer.getByRole('button', { name: /Add note/i }).click();
    await drawer.getByRole('textbox', { name: 'New task note' }).fill(noteBody);
    const noteSaved = page.waitForResponse((response) =>
      response.url().endsWith(`/api/task-agent/tasks/${task.id}/notes`)
      && response.request().method() === 'POST');
    await drawer.getByRole('button', { name: 'Save note' }).click();
    expect((await noteSaved).status()).toBe(201);
    await expect(drawer.getByText(noteBody, { exact: true })).toBeVisible();

    const storedNotes = await page.request.get(`${url}/api/task-agent/tasks/${task.id}/notes`);
    expect(storedNotes.ok()).toBe(true);
    const noteEntries = (await storedNotes.json()).notes as Array<{ body: string; created_at: string }>;
    expect(noteEntries[0]?.body).toBe(noteBody);
    expect(Number.isNaN(Date.parse(noteEntries[0]!.created_at))).toBe(false);

    const updated = page.waitForResponse((response) =>
      response.url().endsWith(`/api/tasks/${task.id}`)
      && response.request().method() === 'PATCH');
    await card.locator('button[title="Mark done"]').click();
    expect((await updated).ok()).toBe(true);
    await expect(card.locator('button[aria-pressed="true"]')).toBeVisible();
    // The completion ritual is optional; dismiss it while preserving the completed task.
    const skipRitual = page.getByTitle('Skip — the task stays done');
    if (await skipRitual.isVisible().catch(() => false)) await skipRitual.click();
  } finally {
    await data.cleanup();
  }
});
