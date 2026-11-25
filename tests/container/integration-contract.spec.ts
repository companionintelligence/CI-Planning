import { test, expect, type Response } from '@playwright/test';
import { signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;

test('task assistant reports an unavailable planning provider without creating tasks', async ({ page }) => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
  await signInLocal(page, url);

  let requestBody: { text?: string; history?: Array<{ role: string; text: string }>; screen?: { path?: string } } | undefined;
  await page.route('**/api/task-agent/plan', async (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Planning provider unavailable (fixture)' }),
    });
  });

  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Talk to task assistant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task assistant' });
  const muteReplies = dialog.getByRole('button', { name: 'Mute replies' });
  if (await muteReplies.isVisible().catch(() => false)) await muteReplies.click();

  const request = 'Create a task called provider outage check';
  await dialog.getByRole('textbox', { name: 'Message the task assistant' }).fill(request);
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(dialog.getByRole('alert')).toHaveText('Planning provider unavailable (fixture)');
  expect(requestBody).toMatchObject({ text: request, history: [], screen: { path: '/' } });
  const tasksResponse = await page.request.get(`${url}/api/tasks`);
  expect(tasksResponse.ok()).toBe(true);
  const tasks = ((await tasksResponse.json()).tasks as Array<{ title: string }>);
  expect(tasks.some((task) => task.title === 'provider outage check')).toBe(false);
});
