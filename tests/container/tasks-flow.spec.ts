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

test('task swipe actions persist after reload', async ({ page }, testInfo) => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
  const runId = `${testInfo.testId}-${Date.now()}`;
  const data = new OwnerFixtures(page.request, runId);
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.setViewportSize({ width: 430, height: 900 });

  const card = (title: string) => page.locator('.task-card').filter({ hasText: title });
  const swipe = async (title: string, direction: 1 | -1) => {
    const label = card(title).getByText(title, { exact: true });
    await label.scrollIntoViewIfNeeded();
    const bounds = await label.boundingBox();
    if (!bounds) throw new Error(`Cannot swipe a hidden task: ${title}`);
    const x = Math.round(bounds.x + Math.min(bounds.width / 2, 50));
    const y = Math.round(bounds.y + bounds.height / 2);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const distance of [30, 70, 100]) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x + direction * distance, y }],
      });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const mutation = (path: string, method: string) => page.waitForResponse((response) =>
    new URL(response.url()).pathname === path && response.request().method() === method);

  try {
    await signInLocal(page, url);
    const staged = await data.createTask({ title: `Stage ${runId}` });
    const archived = await data.createTask({ title: `Archive ${runId}` });
    const deleted = await data.createTask({ title: `Delete ${runId}` });
    await page.goto(`${url}/tasks`);

    const stageWrite = mutation('/api/flight-plan', 'POST');
    await swipe(staged.title, 1);
    expect((await stageWrite).ok()).toBe(true);
    await expect(card(staged.title)).toHaveClass(/opacity-40/);
    await expect(card(staged.title).getByText('Flight Plan', { exact: true })).toBeHidden();
    await expect(card(staged.title).getByRole('button', { name: `Archive ${staged.title}` })).toBeHidden();
    await expect(card(staged.title).getByRole('button', { name: `Delete ${staged.title}` })).toBeHidden();

    await swipe(archived.title, -1);
    const archiveWrite = mutation(`/api/tasks/${archived.id}/archive`, 'POST');
    await page.getByRole('button', { name: `Archive ${archived.title}`, exact: true }).click();
    expect((await archiveWrite).ok()).toBe(true);
    await expect(card(archived.title)).toHaveCount(0);

    await swipe(deleted.title, -1);
    const deleteWrite = mutation(`/api/tasks/${deleted.id}`, 'DELETE');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: `Delete ${deleted.title}`, exact: true }).click();
    expect((await deleteWrite).ok()).toBe(true);

    await page.reload();
    await expect(card(staged.title)).toHaveClass(/opacity-40/);
    await expect(card(archived.title)).toHaveCount(0);
    await expect(card(deleted.title)).toHaveCount(0);
    const flightPlan = await page.request.get(`${url}/api/flight-plan`);
    expect(flightPlan.ok()).toBe(true);
    expect((await flightPlan.json()).flight_plan).toContainEqual(expect.objectContaining({ task_id: staged.id }));

    await page.getByTitle('View completed and thrown-away tasks').click();
    for (const [task, section] of [[archived, 'Archived'], [deleted, 'Thrown away']] as const) {
      const sectionToggle = page.getByRole('button', { name: new RegExp(`^${section}\\s+\\d+$`) });
      await expect(sectionToggle.locator('..').getByText(task.title, { exact: true })).toBeVisible();
    }
    for (const [task, status] of [[archived, 'archived'], [deleted, 'cancelled']] as const) {
      const response = await page.request.get(`${url}/api/tasks?status=${status}`);
      expect(response.ok()).toBe(true);
      expect((await response.json()).tasks).toContainEqual(expect.objectContaining({ id: task.id, status }));
    }
  } finally {
    await data.cleanup();
    await touch.detach();
  }
});
