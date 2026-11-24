import { test, expect, type Response } from '@playwright/test';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;

test('Task assistant carries a clarification into editable drafts and creates them only on confirm', async ({ page }, testInfo) => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
  test.setTimeout(60_000);
  const data = new OwnerFixtures(page.request, testInfo.testId);
  const runKey = `${testInfo.testId}-${Date.now()}`;
  const planRequests: Array<{ text: string; history: Array<{ role: string; text: string }> }> = [];
  const createResponses: Response[] = [];

  try {
    await signInLocal(page, url);
    await page.route('**/api/task-agent/plan', async (route) => {
      const request = route.request().postDataJSON() as { text: string; history: Array<{ role: string; text: string }> };
      planRequests.push(request);
      const plan = planRequests.length === 1
        ? {
            reply: 'Should I put these in a time block or create them individually?',
            actions: [], tasks: [], objectives: [],
          }
        : {
            reply: 'I kept the original task names and drafted two individual tasks for review.',
            actions: [{
              kind: 'create_tasks',
              tasks: [
                { title: `Prepare breakfast ${runKey}`, estimated_minutes: 15 },
                { title: `Feed cats ${runKey}`, estimated_minutes: 20 },
              ],
            }],
            tasks: [], objectives: [],
          };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(plan) });
    });
    page.on('response', (response) => {
      if (response.url().endsWith('/api/tasks') && response.request().method() === 'POST') createResponses.push(response);
    });

    await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Talk to task assistant' }).click();
    const dialog = page.getByRole('dialog', { name: 'Task assistant' });
    const muteReplies = dialog.getByRole('button', { name: 'Mute replies' });
    if (await muteReplies.isVisible().catch(() => false)) await muteReplies.click();
    const input = dialog.getByRole('textbox', { name: 'Message the task assistant' });
    const send = dialog.getByRole('button', { name: 'Send', exact: true });

    await input.fill(`Create breakfast and feed cats ${runKey}`);
    await send.click();
    await expect(dialog.getByText('Should I put these in a time block or create them individually?')).toBeVisible();

    await input.fill('Create them individually; breakfast takes 15 minutes and feeding cats takes 20.');
    await send.click();
    await expect(dialog.getByText('Review changes')).toBeVisible();
    const firstDraft = dialog.getByRole('textbox', { name: 'Draft task 1', exact: true });
    const secondDraft = dialog.getByRole('textbox', { name: 'Draft task 2', exact: true });
    await expect(firstDraft).toHaveValue(`Prepare breakfast ${runKey}`);
    await expect(secondDraft).toHaveValue(`Feed cats ${runKey}`);
    expect(planRequests).toHaveLength(2);
    expect(planRequests[1]!.history).toEqual(expect.arrayContaining([
      { role: 'user', text: `Create breakfast and feed cats ${runKey}` },
      { role: 'assistant', text: 'Should I put these in a time block or create them individually?' },
    ]));

    // The proposal is still a draft until confirmation; edits here become the saved values.
    const beforeConfirm = await page.request.get(`${url}/api/tasks`);
    expect(beforeConfirm.ok()).toBe(true);
    const existingTasks = ((await beforeConfirm.json()).tasks as Array<{ title: string }>);
    expect(existingTasks.some((task) => task.title.includes(runKey))).toBe(false);
    await firstDraft.fill(`Make breakfast ${runKey}`);
    const firstDuration = dialog.getByRole('spinbutton', { name: 'Minutes for draft task 1', exact: true });
    await firstDuration.fill('25');
    await expect(firstDuration).toHaveValue('25');
    expect(createResponses).toHaveLength(0);

    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect.poll(() => createResponses.length).toBe(2);
    const created = await Promise.all(createResponses.map(async (response) => {
      expect(response.status()).toBe(201);
      return (await response.json()).task as { id: string; title: string; estimated_minutes: number | null };
    }));
    for (const task of created) data.trackTask(task.id);
    expect(created.map((task) => [task.title, task.estimated_minutes])).toEqual([
      [`Make breakfast ${runKey}`, 25],
      [`Feed cats ${runKey}`, 20],
    ]);
    await expect(dialog.getByText('1 change saved.')).toBeVisible();
  } finally {
    await data.cleanup();
  }
});
