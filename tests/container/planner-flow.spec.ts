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
