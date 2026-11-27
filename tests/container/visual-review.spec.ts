import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;
const themes = ['light', 'dark'] as const;
const viewports = [
  { id: 'desktop-1280x800', width: 1280, height: 800 },
  { id: 'phone-430x900', width: 430, height: 900 },
] as const;
const authenticatedSurfaces = [
  { id: 'today-planner', path: '/' },
  { id: 'focus', path: '/focus' },
  { id: 'calendar', path: '/calendar' },
  { id: 'tasks', path: '/tasks' },
  { id: 'objectives', path: '/tasks?tab=objectives' },
  { id: 'routines', path: '/tasks?tab=routines' },
  { id: 'tags', path: '/tags' },
  { id: 'tags-categories', path: '/tags', tab: 'Time Block Categories' },
  { id: 'priorities', path: '/priorities' },
  { id: 'balance', path: '/balance' },
  { id: 'settings-profile', path: '/settings', tab: 'Profile' },
  { id: 'settings-preferences', path: '/settings?tab=preferences', tab: 'Preferences' },
  { id: 'settings-learning', path: '/settings', tab: 'Learning' },
  { id: 'settings-connections', path: '/settings', tab: 'Connections' },
  { id: 'settings-people', path: '/settings?tab=people', tab: 'People' },
  { id: 'settings-logs', path: '/settings', tab: 'Logs' },
  { id: 'settings-privacy', path: '/settings', tab: 'Privacy' },
  { id: 'jobs', path: '/jobs' },
] as const;
const publicSurfaces = [
  { id: 'login', path: '/login' },
  { id: 'signup', path: '/signup' },
  { id: 'reset-password', path: '/reset-password' },
] as const;

async function waitForStablePage(page: Page) {
  const enter = page.locator('.page-enter').first();
  if (await enter.count()) {
    await enter.evaluate((element) => Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    ));
  }
}

async function saveScreenshot(page: Page, root: string, theme: string, viewport: string, surface: string) {
  const path = resolve(root, theme, viewport, `${surface}.png`);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
}

test('captures full route and theme review set', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(!username || !password, 'requires an authenticated local-login container');
  const browser = page.context().browser();
  if (!browser) throw new Error('Visual review requires the configured Chromium browser.');
  const artifactRoot = resolve(process.env.UI_REVIEW_DIR || testInfo.outputPath('route-theme-screenshots'));
  const data = new OwnerFixtures(page.request, `visual-review-${testInfo.testId}`, url);
  const publicContexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];

  try {
    await signInLocal(page, url);
    const start = await page.evaluate(() => {
      const value = new Date();
      value.setHours(value.getHours() + 2, 0, 0, 0);
      return { date: `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`, start: value.toISOString() };
    });
    const scheduledTask = await data.createTask({ title: 'UI review scheduled task', scheduled_for: start.date, estimated_minutes: 30 });
    const stagedTask = await data.createTask({ title: 'UI review staged task', estimated_minutes: 25 });
    await data.stageTask(stagedTask.id);
    await data.createBlock({
      title: 'UI review focus block',
      start_at: start.start,
      end_at: new Date(Date.parse(start.start) + 60 * 60_000).toISOString(),
      block_kind: 'timeblock',
    });
    await data.createObjective(`UI review objective ${testInfo.testId}`);
    const reviewDirection = await data.createTag({ name: `UI Review Direction ${testInfo.testId}`, kind: 'direction' });
    const reviewCategory = await data.createTag({ name: `UI Review Category ${testInfo.testId}`, kind: 'category' });
    const reviewIntention = await data.createTag({
      name: `UI Review Intention ${testInfo.testId}`,
      kind: 'intention',
      directions: [reviewDirection.name],
      categories: [reviewCategory.name],
    });

    for (const theme of themes) {
      const publicContext = await browser.newContext();
      publicContexts.push(publicContext);
      const publicPage = await publicContext.newPage();
      await publicPage.addInitScript((savedTheme) => localStorage.setItem('vite-ui-theme', savedTheme), theme);

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-app-shell]')).toBeVisible();
      await page.getByLabel('Theme mode').selectOption(theme);
      await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
        .toBe(theme === 'dark');

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        for (const surface of authenticatedSurfaces) {
          await page.goto(`${url}${surface.path}`, { waitUntil: 'domcontentloaded' });
          await expect(page.locator('[data-app-shell]')).toBeVisible();
          if ('tab' in surface) {
            const tab = page.getByRole('tab', { name: surface.tab, exact: true });
            await expect(tab).toBeVisible();
            await tab.click();
            await expect(tab).toHaveAttribute('aria-selected', 'true');
          }
          if (surface.id === 'settings-logs' && viewport.id === 'phone-430x900') {
            const actions = page.locator('.settings-log-actions');
            const bounds = await actions.boundingBox();
            const viewportWidth = await page.evaluate(() => window.innerWidth);
            expect(bounds, 'Settings log actions are rendered on phone').not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth + 1);
            await expect(page.getByRole('button', { name: /Consolidate \(summarize\)/ })).toBeVisible();
            await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toBeVisible();
          }
          if (surface.id === 'tags' && viewport.id === 'phone-430x900') {
            await expect(page.getByRole('button', { name: 'Show Talk to task assistant' })).toBeVisible();
            await expect(page.getByRole('button', { name: 'Show Add to calendar' })).toBeVisible();
          }
          await waitForStablePage(page);
          if (surface.id === 'tags') {
            await expect(page.getByText(`#${reviewIntention.name}`, { exact: true })).toBeVisible();
          }
          await saveScreenshot(page, artifactRoot, theme, viewport.id, surface.id);
        }

        await page.goto(`${url}/tasks?task=${encodeURIComponent(scheduledTask.id)}`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.details-drawer')).toBeVisible();
        await waitForStablePage(page);
        await saveScreenshot(page, artifactRoot, theme, viewport.id, 'task-details');

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const drawerToggle = page.getByRole('button', { name: /details drawer/i }).first();
        if (await drawerToggle.getAttribute('aria-expanded') !== 'true') await drawerToggle.click();
        await page.getByRole('tab', { name: 'Flight Plan' }).click();
        await expect(page.getByRole('region', { name: 'Flight Plan', exact: true })).toBeVisible();
        await waitForStablePage(page);
        await saveScreenshot(page, artifactRoot, theme, viewport.id, 'flight-plan');

        for (const surface of publicSurfaces) {
          const response = await publicPage.goto(`${url}${surface.path}`, { waitUntil: 'domcontentloaded' });
          expect(response?.status(), `${surface.path} should load for review`).toBeLessThan(400);
          await publicPage.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
          await waitForStablePage(publicPage);
          await saveScreenshot(publicPage, artifactRoot, theme, viewport.id, surface.id);
        }
      }
    }
  } finally {
    await Promise.all(publicContexts.map((context) => context.close()));
    await data.cleanup();
  }
});
