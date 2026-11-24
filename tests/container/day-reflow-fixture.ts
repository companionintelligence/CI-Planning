import type { Page, TestInfo } from '@playwright/test';
import { OwnerFixtures } from './owner-fixtures.js';

const appUrl = () => (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '');

function localWallTimeToIso(date: string, time: string, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let timestamp = target;
  // Correct the UTC guess by the difference between the requested wall time and the
  // wall time that the owner timezone displays for that instant.
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    timestamp += target - shown;
  }
  return new Date(timestamp).toISOString();
}

export interface DayReflowFixture {
  date: string;
  taskTitle: string;
  cleanup: () => Promise<void>;
}

/** Seed a private custom direction/day type so the test can create one stranded task. */
export async function createDayReflowFixture(page: Page, testInfo: TestInfo): Promise<DayReflowFixture> {
  const baseUrl = appUrl();
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dayTypeKey = `e2e-${suffix}`;
  const directionName = `e2e-${suffix}`;
  const taskTitle = `E2E day reflow ${testInfo.testId}`;
  const date = await page.evaluate(() => {
    const target = new Date();
    target.setDate(target.getDate() + 3);
    return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  });
  const prefsResponse = await page.request.get(`${baseUrl}/api/prefs`);
  if (!prefsResponse.ok()) throw new Error(`Could not read scheduling timezone (${prefsResponse.status()}).`);
  const prefs = (await prefsResponse.json() as { prefs?: { timezone?: string } }).prefs;
  const timezone = prefs?.timezone || 'UTC';

  const tagResponse = await page.request.post(`${baseUrl}/api/tags`, { data: { name: directionName, kind: 'direction' } });
  if (!tagResponse.ok()) throw new Error(`Could not create test direction (${tagResponse.status()}): ${await tagResponse.text()}`);
  const tagId = (await tagResponse.json() as { tag: { id: string; name: string } }).tag.id;

  let dayTypeId: string | undefined;
  const data = new OwnerFixtures(page.request, testInfo.testId, baseUrl);
  try {
    const typeResponse = await page.request.post(`${baseUrl}/api/day-types`, {
      data: { key: dayTypeKey, name: `E2E reflow ${suffix}` },
    });
    if (!typeResponse.ok()) throw new Error(`Could not create test day type (${typeResponse.status()}): ${await typeResponse.text()}`);
    dayTypeId = (await typeResponse.json() as { day_type: { id: string } }).day_type.id;

    const windowsResponse = await page.request.put(`${baseUrl}/api/pattern-blocks/${encodeURIComponent(tagId)}/${encodeURIComponent(dayTypeKey)}`, {
      data: { ranges: [{ start_time: '10:00', end_time: '11:00' }] },
    });
    if (!windowsResponse.ok()) throw new Error(`Could not configure test day type (${windowsResponse.status()}): ${await windowsResponse.text()}`);
    const assignmentResponse = await page.request.put(`${baseUrl}/api/day-types/assignments/${date}`, {
      data: { day_type_key: dayTypeKey },
    });
    if (!assignmentResponse.ok()) throw new Error(`Could not assign test day type (${assignmentResponse.status()}): ${await assignmentResponse.text()}`);

    const task = await data.createTask({ title: taskTitle, estimated_minutes: 30 });
    const startAt = localWallTimeToIso(date, '14:00', timezone);
    const endAt = new Date(Date.parse(startAt) + 30 * 60_000).toISOString();
    await data.createBlock({ title: taskTitle, task_id: task.id, block_kind: 'task', tag: directionName, start_at: startAt, end_at: endAt });
  } catch (error) {
    await data.cleanup().catch(() => undefined);
    if (dayTypeId) {
      await page.request.put(`${baseUrl}/api/pattern-blocks/${encodeURIComponent(tagId)}/${encodeURIComponent(dayTypeKey)}`, { data: { ranges: [] } }).catch(() => undefined);
      await page.request.delete(`${baseUrl}/api/day-types/assignments/${date}`).catch(() => undefined);
      await page.request.delete(`${baseUrl}/api/day-types/${encodeURIComponent(dayTypeId)}`).catch(() => undefined);
    }
    await page.request.delete(`${baseUrl}/api/tags/${encodeURIComponent(tagId)}`).catch(() => undefined);
    throw error;
  }

  return {
    date,
    taskTitle,
    cleanup: async () => {
      await data.cleanup();
      const removeWindows = await page.request.put(`${baseUrl}/api/pattern-blocks/${encodeURIComponent(tagId)}/${encodeURIComponent(dayTypeKey)}`, { data: { ranges: [] } });
      if (!removeWindows.ok()) throw new Error(`Could not remove test day type windows (${removeWindows.status()}).`);
      const removeAssignment = await page.request.delete(`${baseUrl}/api/day-types/assignments/${date}`);
      if (!removeAssignment.ok()) throw new Error(`Could not remove test day assignment (${removeAssignment.status()}).`);
      const removeType = await page.request.delete(`${baseUrl}/api/day-types/${encodeURIComponent(dayTypeId!)}`);
      if (!removeType.ok()) throw new Error(`Could not remove test day type (${removeType.status()}).`);
      const removeTag = await page.request.delete(`${baseUrl}/api/tags/${encodeURIComponent(tagId)}`);
      if (!removeTag.ok()) throw new Error(`Could not remove test direction (${removeTag.status()}).`);
    },
  };
}

export async function selectFocusDate(page: Page, date: string): Promise<void> {
  await page.goto(`${appUrl()}/focus`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Choose Focus day' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose Focus day' });
  const wanted = new Date(`${date}T12:00:00`);
  const wantedMonth = wanted.getFullYear() * 12 + wanted.getMonth();
  for (let count = 0; count < 24; count++) {
    const monthText = await dialog.locator('h2').innerText();
    const shown = new Date(`${monthText} 1`);
    const shownMonth = shown.getFullYear() * 12 + shown.getMonth();
    if (shownMonth === wantedMonth) break;
    await dialog.getByRole('button', { name: shownMonth < wantedMonth ? 'Next month' : 'Previous month' }).click();
  }
  const dateLabel = wanted.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  await dialog.getByRole('button', { name: dateLabel, exact: true }).click();
  await dialog.getByRole('button', { name: 'Choose day' }).click();
}
