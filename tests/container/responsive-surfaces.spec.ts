import { test, expect, type Locator, type Page } from '@playwright/test';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;

test.use({ viewport: { width: 430, height: 560 } });

async function expectWithinVisualViewport(page: Page, surface: Locator): Promise<void> {
  const withinViewport = async () => {
    const bounds = await surface.boundingBox();
    const viewport = await page.evaluate(() => ({
      width: window.visualViewport?.width ?? window.innerWidth,
      height: window.visualViewport?.height ?? window.innerHeight,
    }));
    return !!bounds
      && bounds.x >= 0
      && bounds.y >= 0
      && bounds.x + bounds.width <= viewport.width + 1
      && bounds.y + bounds.height <= viewport.height + 1;
  };
  // Sheet entrance uses a spring-like transform, so wait for its brief overshoot
  // to settle before asserting the final viewport geometry.
  await expect.poll(withinViewport, { timeout: 5_000 }).toBe(true);
  const bounds = await surface.boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight }));
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('task and objective sheets stay in the mobile viewport and return focus to their openers', async ({ page }) => {
  test.skip(!username || !password, 'requires an authenticated container with LOGIN_USER and LOGIN_PASS');
  await signInLocal(page, url);
  await page.setViewportSize({ width: 430, height: 560 });

  await page.goto(`${url}/tasks`, { waitUntil: 'domcontentloaded' });
  const addTask = page.locator('button[title="Add to calendar"]');
  await expect(addTask).toBeVisible();
  await addTask.click();
  const taskDialog = page.getByRole('dialog', { name: 'Add task' });
  await expect(taskDialog).toBeVisible();
  await expect(taskDialog.getByRole('button', { name: 'Close task form' })).toBeVisible();
  await expectWithinVisualViewport(page, taskDialog);

  // A focused field can shrink the visual viewport when the mobile keyboard opens.
  await page.setViewportSize({ width: 430, height: 420 });
  await expectWithinVisualViewport(page, taskDialog);
  await taskDialog.getByRole('button', { name: 'Close task form' }).click();
  await expect(taskDialog).toHaveCount(0);
  await expect(addTask).toBeFocused();

  await page.goto(`${url}/tasks?tab=objectives`, { waitUntil: 'domcontentloaded' });
  const addObjective = page.getByRole('button', { name: 'New Objective', exact: true });
  await expect(addObjective).toBeVisible();
  await addObjective.click();
  const objectiveDialog = page.getByRole('dialog', { name: 'New Objective' });
  await expect(objectiveDialog).toBeVisible();
  await expect(objectiveDialog.getByRole('textbox', { name: 'Title', exact: true })).toBeFocused();
  await expectWithinVisualViewport(page, objectiveDialog);

  await page.setViewportSize({ width: 430, height: 420 });
  await expectWithinVisualViewport(page, objectiveDialog);
  await objectiveDialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(objectiveDialog).toHaveCount(0);
  await expect(addObjective).toBeFocused();
});

test('overdue due-list dialog stays in the short mobile viewport and returns focus', async ({ page }, testInfo) => {
  test.skip(!username || !password, 'requires an authenticated container with LOGIN_USER and LOGIN_PASS');
  const data = new OwnerFixtures(page.request, testInfo.testId);

  try {
    await signInLocal(page, url);
    const overdueDate = await page.evaluate(() => {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    const overdueTask = await data.createTask({
      title: `E2E overdue viewport ${testInfo.testId}`,
      due_at: overdueDate,
    });

    await page.setViewportSize({ width: 430, height: 420 });
    await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
    const dueButton = page.getByRole('button', { name: 'Due — deadlines for this day' }).first();
    await expect(dueButton).toBeVisible();
    await dueButton.click();

    const dueDialog = page.getByRole('dialog', { name: 'Due list' });
    await expect(dueDialog).toBeVisible();
    await expect(dueDialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
    await expectWithinVisualViewport(page, dueDialog);

    await dueDialog.getByTitle('Show overdue tasks').click();
    await expect(dueDialog.getByText(overdueTask.title, { exact: true })).toBeVisible();
    await expectWithinVisualViewport(page, dueDialog);
    await page.keyboard.press('Escape');
    await expect(dueDialog).toHaveCount(0);
    await expect(dueButton).toBeFocused();
  } finally {
    await data.cleanup();
  }
});
