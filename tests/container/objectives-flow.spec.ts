import { test, expect } from '@playwright/test';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;

interface ObjectiveNodeResponse {
  id: string;
  parent_id: string | null;
  progress_cache: number | null;
  tasks: Array<{ id: string; title: string }>;
  children?: ObjectiveNodeResponse[];
}

test.use({ viewport: { width: 430, height: 900 } });

test('Objective child creation can be reset to top level and directly receive a task', async ({ page }, testInfo) => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
  test.setTimeout(60_000);
  page.setDefaultTimeout(10_000);
  const data = new OwnerFixtures(page.request, testInfo.testId);

  try {
    await signInLocal(page, url);
    const parent = await data.createObjective(`E2E objective parent ${testInfo.testId}`);
    const childTitle = `E2E top-level objective ${testInfo.testId}`;

    await page.goto(`${url}/tasks?tab=objectives`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(parent.title, { exact: true })).toBeVisible();
    const parentHeader = page.locator('.objective-header').filter({ hasText: parent.title });
    await parentHeader.hover();
    await parentHeader.getByTitle('Add child').click();

    const parentPicker = page.getByLabel('Parent', { exact: true });
    await expect(parentPicker).toHaveValue(parent.id);
    await parentPicker.selectOption('', { timeout: 10_000 });
    const titleInput = page.getByRole('textbox', { name: 'Title', exact: true });
    await titleInput.fill(childTitle);
    await expect(titleInput).toHaveValue(childTitle);

    const objectiveCreated = page.waitForResponse((response) =>
      response.url().endsWith('/api/objectives') && response.request().method() === 'POST', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const createdResponse = await objectiveCreated;
    expect(createdResponse.status()).toBe(201);
    const created = (await createdResponse.json()).objective as { id: string; parent_id: string | null };
    expect(created.parent_id, 'None (top-level) is persisted as a root objective').toBeNull();
    data.trackObjective(created.id);

    const createdObjective = page.locator('.objective-header').filter({ hasText: childTitle }).locator('..');
    await expect(createdObjective).toBeVisible();
    const taskTitle = `E2E direct objective task ${testInfo.testId}`;
    await createdObjective.getByRole('button', { name: 'Add task to this objective', exact: true }).click();
    const taskInput = page.getByPlaceholder('Task name — Enter to add and edit');
    await taskInput.fill(taskTitle);
    const taskCreated = page.waitForResponse((response) =>
      response.url().endsWith(`/api/objectives/${created.id}/tasks/create`)
      && response.request().method() === 'POST', { timeout: 10_000 });
    await taskInput.press('Enter');
    const taskResponse = await taskCreated;
    expect(taskResponse.status()).toBe(201);
    const task = (await taskResponse.json()).task as { id: string; title: string };
    data.trackTask(task.id);

    const treeResponse = await page.request.get(`${url}/api/objectives`);
    expect(treeResponse.ok()).toBe(true);
    const tree = (await treeResponse.json()).objectives as ObjectiveNodeResponse[];
    const flatten = (nodes: ObjectiveNodeResponse[]): ObjectiveNodeResponse[] =>
      nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    const persisted = flatten(tree).find((objective) => objective.id === created.id);
    expect(persisted?.parent_id).toBeNull();
    expect(persisted?.tasks.some((entry) => entry.id === task.id && entry.title === taskTitle)).toBe(true);
    expect(persisted?.progress_cache, 'a linked open task initializes objective progress').not.toBeNull();
  } finally {
    await data.cleanup();
  }
});
