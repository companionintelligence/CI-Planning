import { test, expect } from '@playwright/test';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;

test.use({ timezoneId: 'America/Los_Angeles' });

test('Planner auto-schedules staged tasks around a meeting without overlap and supports undo', async ({ page }, testInfo) => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
  const data = new OwnerFixtures(page.request, testInfo.testId);

  try {
    await signInLocal(page, url);
    const day = await page.evaluate(() => {
      const target = new Date();
      target.setDate(target.getDate() + 2);
      const year = target.getFullYear();
      const month = target.getMonth();
      const dayNumber = target.getDate();
      const pad = (value: number) => String(value).padStart(2, '0');
      const date = `${year}-${pad(month + 1)}-${pad(dayNumber)}`;
      const start = new Date(year, month, dayNumber);
      const nextDay = new Date(year, month, dayNumber + 1);
      return {
        date,
        from: start.toISOString(),
        to: nextDay.toISOString(),
        meetingStart: new Date(year, month, dayNumber, 8, 0).toISOString(),
        meetingEnd: new Date(year, month, dayNumber, 9, 0).toISOString(),
      };
    });

    const meeting = await data.createBlock({
      title: `E2E meeting ${testInfo.testId}`,
      block_kind: 'meeting',
      start_at: day.meetingStart,
      end_at: day.meetingEnd,
    });
    const firstTask = await data.createTask({
      title: `E2E planner first ${testInfo.testId}`,
      estimated_minutes: 30,
      priority: 1,
    });
    const secondTask = await data.createTask({
      title: `E2E planner second ${testInfo.testId}`,
      estimated_minutes: 30,
      priority: 2,
    });
    await data.stageTask(firstTask.id);
    await data.stageTask(secondTask.id);

    const dayPicker = page.getByTitle('Pick a day').locator('input[type="date"]');
    await dayPicker.fill(day.date);
    await expect(dayPicker).toHaveValue(day.date);

    const quickActions = page.getByRole('button', { name: 'Planner quick actions' });
    await quickActions.click();
    const schedule = page.getByRole('button', { name: 'Schedule', exact: true });
    const scheduled = page.waitForResponse((response) =>
      response.url().endsWith('/api/auto/run') && response.request().method() === 'POST');
    await schedule.click();
    const scheduleResponse = await scheduled;
    expect(scheduleResponse.ok()).toBe(true);
    expect((await scheduleResponse.json()).result.placed).toBe(2);

    const range = new URLSearchParams({ from: day.from, to: day.to });
    const blocksResponse = await page.request.get(`${url}/api/blocks?${range}`);
    expect(blocksResponse.ok()).toBe(true);
    const blocks = (await blocksResponse.json()).blocks as Array<{
      id: string;
      task_id: string | null;
      title: string;
      block_kind: string;
      status: string;
      is_locked: boolean;
      start_at: string;
      end_at: string;
    }>;
    const taskIds = new Set([firstTask.id, secondTask.id]);
    const placed = blocks
      .filter((block) => taskIds.has(block.task_id ?? '') && block.block_kind === 'task')
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
    expect(placed).toHaveLength(2);
    expect(placed[0]!.end_at <= placed[1]!.start_at, 'auto-placed task intervals do not overlap').toBe(true);
    expect(placed[0]!.end_at, 'the next task uses the next available minute without an inserted break').toBe(placed[1]!.start_at);

    const obstacles = blocks.filter((block) =>
      block.id === meeting.id || block.is_locked || block.block_kind === 'meeting'
      || (block.block_kind === 'task' && !['completed', 'skipped', 'cancelled'].includes(block.status)));
    for (const task of placed) {
      for (const obstacle of obstacles) {
        if (task.id === obstacle.id) continue;
        const intersects = task.start_at < obstacle.end_at && obstacle.start_at < task.end_at;
        expect(intersects, `${task.title} must not overlap ${obstacle.title}`).toBe(false);
      }
    }

    if (await quickActions.getAttribute('aria-expanded') !== 'true') await quickActions.click();
    await expect(page.getByTitle('Undo the last Schedule run')).toBeVisible();
    await page.getByTitle('Undo the last Schedule run').click();
    const undoConfirm = page.waitForResponse((response) =>
      response.url().endsWith('/api/auto/undo') && response.request().method() === 'POST');
    await page.getByTitle('Confirm undo').click();
    expect((await undoConfirm).ok()).toBe(true);

    const afterUndo = await page.request.get(`${url}/api/blocks?${range}`);
    const remaining = ((await afterUndo.json()).blocks as Array<{ task_id: string | null }>);
    expect(remaining.filter((block) => taskIds.has(block.task_id ?? ''))).toHaveLength(0);
    const stagedResponse = await page.request.get(`${url}/api/flight-plan`);
    const staged = ((await stagedResponse.json()).flight_plan as Array<{ task_id: string }>).map((item) => item.task_id);
    expect(staged).toEqual(expect.arrayContaining([...taskIds]));
  } finally {
    await data.cleanup();
  }
});

test('Planner time blocks can be edited and an overlap warning clears after moving a block', async ({ page }, testInfo) => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
  test.setTimeout(60_000);
  page.setDefaultTimeout(10_000);
  const data = new OwnerFixtures(page.request, testInfo.testId);

  try {
    await signInLocal(page, url);
    const unique = `${testInfo.testId}-${Date.now()}`;
    const day = await page.evaluate(() => {
      const target = new Date();
      target.setDate(target.getDate() + 2);
      const year = target.getFullYear();
      const month = target.getMonth();
      const dayNumber = target.getDate();
      const pad = (value: number) => String(value).padStart(2, '0');
      const date = `${year}-${pad(month + 1)}-${pad(dayNumber)}`;
      const iso = (hour: number, minute: number) => new Date(year, month, dayNumber, hour, minute).toISOString();
      const start = new Date(year, month, dayNumber);
      const nextDay = new Date(year, month, dayNumber + 1);
      return {
        date,
        from: start.toISOString(),
        to: nextDay.toISOString(),
        firstStart: iso(13, 0),
        secondStart: iso(13, 30),
        movedStart: iso(14, 30),
        containerStart: iso(17, 0),
        containerEnd: iso(18, 0),
      };
    });

    const firstTask = await data.createTask({ title: `E2E overlap first ${unique}`, estimated_minutes: 60 });
    const secondTask = await data.createTask({ title: `E2E overlap second ${unique}`, estimated_minutes: 60 });
    const firstBlock = await data.createBlock({
      title: firstTask.title, task_id: firstTask.id, block_kind: 'task',
      start_at: day.firstStart, end_at: new Date(Date.parse(day.firstStart) + 60 * 60_000).toISOString(),
    });
    await data.createBlock({
      title: secondTask.title, task_id: secondTask.id, block_kind: 'task',
      start_at: day.secondStart, end_at: new Date(Date.parse(day.secondStart) + 60 * 60_000).toISOString(),
    });
    const timeBlock = await data.createBlock({
      title: `E2E editable block ${unique}`,
      block_kind: 'timeblock', start_at: day.containerStart, end_at: day.containerEnd,
    });

    await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
    const dayPicker = page.getByTitle('Pick a day').locator('input[type="date"]');
    await dayPicker.fill(day.date);
    await expect(dayPicker).toHaveValue(day.date);
    const detailsToggle = page.getByRole('button', { name: /details drawer/i }).first();
    if (await detailsToggle.getAttribute('aria-expanded') === 'true') await detailsToggle.click();

    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firstChip = page.getByTitle(new RegExp(`^${escapeRegExp(firstTask.title)} ·`));
    const secondChip = page.getByTitle(new RegExp(`^${escapeRegExp(secondTask.title)} ·`));
    await expect(firstChip).toBeVisible();
    await expect(secondChip).toBeVisible();
    await expect(firstChip.locator('svg.text-destructive'), 'an overlapping task shows its warning').toBeVisible();
    await expect(secondChip.locator('svg.text-destructive')).toBeVisible();

    await firstChip.click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit time', exact: true }).click();
    await page.getByLabel('Start', { exact: true }).fill('14:30');
    const saveButton = page.getByRole('button', { name: 'Save time', exact: true });
    const moved = page.waitForResponse((response) =>
      response.url().endsWith(`/api/blocks/${firstBlock.id}`) && response.request().method() === 'PATCH');
    await saveButton.click();
    expect((await moved).ok()).toBe(true);
    await expect(firstChip.locator('svg.text-destructive')).toHaveCount(0);
    await expect(secondChip.locator('svg.text-destructive')).toHaveCount(0);
    await page.getByTitle('Close (Esc)').click();

    const range = new URLSearchParams({ from: day.from, to: day.to });
    const blocksResponse = await page.request.get(`${url}/api/blocks?${range}`);
    expect(blocksResponse.ok()).toBe(true);
    const blocks = (await blocksResponse.json()).blocks as Array<{ id: string; start_at: string }>;
    expect(Date.parse(blocks.find((block) => block.id === firstBlock.id)!.start_at)).toBe(Date.parse(day.movedStart));

    // The outer Time-Block outline is deliberately pointer-transparent; its
    // colored title label is the interactive surface and drag handle.
    await page.locator('[class*="group/label"]').getByText(timeBlock.title, { exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const titleInput = page.getByPlaceholder('Time block title…');
    await expect(titleInput).toHaveValue(timeBlock.title);
    const updatedTitle = `E2E renamed block ${unique}`;
    await titleInput.fill(updatedTitle);
    const renamed = page.waitForResponse((response) =>
      response.url().endsWith(`/api/blocks/${timeBlock.id}`) && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await renamed).ok()).toBe(true);

    const persistedResponse = await page.request.get(`${url}/api/blocks?${range}`);
    const persistedBlocks = (await persistedResponse.json()).blocks as Array<{ id: string; title: string }>;
    expect(persistedBlocks.find((block) => block.id === timeBlock.id)?.title).toBe(updatedTitle);
  } finally {
    await data.cleanup();
  }
});
