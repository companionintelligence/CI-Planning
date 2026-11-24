import { test, expect } from '@playwright/test';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;

interface TaskMetricTotals {
  completed: number;
  actualMinutes: number;
  score: { counts: Record<string, number>; samples: number; mean: number | null };
}

const formatMinutes = (minutes: number) => minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}m`;

test('Metrics shows daily completion and task writes, and the assistant recaps the same saved metrics', async ({ page }, testInfo) => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
  test.setTimeout(60_000);
  const data = new OwnerFixtures(page.request, testInfo.testId);

  try {
    await signInLocal(page, url);
    const tomorrow = await page.evaluate(() => {
      const date = new Date();
      const localDate = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      return localDate(nextDay);
    });

    const beforeResponse = await page.request.get(`${url}/api/metrics/tasks?days=7`);
    expect(beforeResponse.ok()).toBe(true);
    const before = (await beforeResponse.json() as { totals: TaskMetricTotals }).totals;

    const task = await data.createTask({
      title: `E2E metrics ${testInfo.testId}`,
      scheduled_for: tomorrow,
      estimated_minutes: 20,
    });
    const closeResponse = await page.request.post(`${url}/api/tasks/${task.id}/close`, {
      data: { score: 4, actual_minutes: 35 },
    });
    expect(closeResponse.status()).toBe(200);

    const afterResponse = await page.request.get(`${url}/api/metrics/tasks?days=7`);
    expect(afterResponse.ok()).toBe(true);
    const after = (await afterResponse.json() as { totals: TaskMetricTotals }).totals;
    expect(after.completed).toBe(before.completed + 1);
    expect(after.actualMinutes).toBe(before.actualMinutes + 35);
    expect(after.score.samples).toBe(before.score.samples + 1);
    expect(after.score.counts['4']).toBe(before.score.counts['4'] + 1);

    await page.goto(`${url}/balance`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Metrics' }).click();
    await expect(page.getByRole('heading', { name: 'Daily completion' })).toBeVisible();
    const todayLabel = await page.evaluate(() => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    const todaySnapshot = page.getByRole('img', { name: new RegExp(`^${todayLabel}:`) });
    await expect(todaySnapshot).toHaveAttribute('aria-label', /earned: Unplanned win/);

    const taskMetrics = page.getByRole('heading', { name: 'Tasks', exact: true }).locator('..');
    const completedCard = taskMetrics.getByText('Completed', { exact: true }).locator('..');
    await expect(completedCard.getByText(String(after.completed), { exact: true })).toBeVisible();
    const trackedCard = taskMetrics.getByText('Time tracked', { exact: true }).locator('..');
    await expect(trackedCard.getByText(formatMinutes(after.actualMinutes), { exact: true })).toBeVisible();
    const ratedCard = taskMetrics.getByText('Rated', { exact: true }).locator('..');
    await expect(ratedCard.getByText(String(after.score.samples), { exact: true })).toBeVisible();
    if (after.score.mean !== null) await expect(ratedCard.getByText(after.score.mean.toFixed(1), { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Talk to task assistant' }).click();
    const dialog = page.getByRole('dialog', { name: 'Task assistant' });
    const muteReplies = dialog.getByRole('button', { name: 'Mute replies' });
    if (await muteReplies.isVisible().catch(() => false)) await muteReplies.click();
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/api/task-agent/plan') && response.request().method() === 'POST');
    await dialog.getByRole('textbox', { name: 'Message the task assistant' }).fill('Give me a metrics recap for the last 7 days.');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const recap = await response.json() as { reply: string; actions: unknown[] };
    expect(recap.actions).toEqual([]);
    expect(recap.reply).toContain(`Over the last 7 days: ${after.completed} tasks completed`);
    expect(recap.reply).toContain(`${after.actualMinutes} minutes tracked`);
    expect(recap.reply).toContain(`${after.score.samples} recorded`);
    if (after.score.mean !== null) expect(recap.reply).toContain(`average ${after.score.mean}/5`);
    await expect(dialog.getByText(recap.reply, { exact: true })).toBeVisible();
  } finally {
    await data.cleanup();
  }
});
