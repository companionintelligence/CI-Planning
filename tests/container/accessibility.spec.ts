import { test, expect, type Page } from '@playwright/test';
import axe from 'axe-core';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

async function expectAxeClean(page: Page, surface: string, rootSelector = 'body') {
  // The route shell animates in from reduced opacity. Wait for that animation to finish
  // so color contrast is measured at the stable visual state users actually see.
  await page.locator('.page-enter').first().evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
  );
  const result = await page.evaluate(async (tags) => {
    const { tags: rules, selector } = tags as { tags: string[]; selector: string };
    const axe = (window as any).axe as typeof import('axe-core') | undefined;
    if (!axe) throw new Error('axe-core was not injected into this page');
    const root = document.querySelector(selector);
    if (!root) throw new Error(`axe scan root not found: ${selector}`);
    const { violations } = await axe.run(root, { runOnly: { type: 'tag', values: rules } });
    return violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => {
        const element = node.target.length ? document.querySelector(node.target[0]!) : null;
        const style = element ? getComputedStyle(element) : null;
        return {
          target: node.target,
          summary: node.failureSummary,
          text: element?.textContent?.trim(),
          html: element?.outerHTML,
          color: style?.color,
          background: style?.backgroundColor,
        };
      }),
    }));
  }, { tags: WCAG_TAGS, selector: rootSelector });
  expect(result, `axe WCAG violations on ${surface}`).toEqual([]);
}

async function waitForFiniteAnimations(surface: ReturnType<Page['locator']>) {
  await surface.evaluate(async (element) => {
    const animations = element.getAnimations({ subtree: true }).filter((animation) =>
      Number.isFinite(animation.effect?.getComputedTiming().iterations ?? 1),
    );
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

test.describe('authenticated accessibility regressions', () => {
  test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');

  test('axe checks representative screens in both themes, including color contrast', async ({ page }) => {
    await signInLocal(page, url);
    await page.addInitScript({ content: axe.source });

    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-app-shell]')).toBeVisible();
      await page.getByLabel('Theme mode').selectOption(theme);
      await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
        .toBe(theme === 'dark');
      await expectAxeClean(page, `Appearance settings (${theme})`, '[data-testid="appearance-accessibility-settings"]');
      await expectAxeClean(page, `Preferences settings (${theme})`);
      await page.getByRole('tab', { name: 'Profile', exact: true }).click();
      await expect(page.getByRole('tab', { name: 'Profile', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expectAxeClean(page, `Profile settings (${theme})`);
      await page.getByRole('tab', { name: 'Learning', exact: true }).click();
      await expect(page.getByTestId('learning-panel')).toBeVisible();
      await expectAxeClean(page, `Learning settings (${theme})`, '[data-testid="learning-panel"]');
      await page.getByRole('tab', { name: 'Connections', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Re-check', exact: true })).toBeEnabled();
      await expectAxeClean(page, `Connections settings (${theme})`);
      for (const section of ['People', 'Logs', 'Privacy'] as const) {
        const sectionTab = page.getByRole('tab', { name: section, exact: true });
        await sectionTab.click();
        await expect(sectionTab).toHaveAttribute('aria-selected', 'true');
        await expectAxeClean(page, `${section} settings (${theme})`);
      }

      await page.goto(`${url}/focus`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Choose Focus day' }).click();
      const focusDateDialog = page.getByRole('dialog', { name: 'Choose Focus day' });
      await expect(focusDateDialog).toBeVisible();
      await waitForFiniteAnimations(focusDateDialog);
      await expectAxeClean(page, `Focus date picker (${theme})`, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(focusDateDialog).toHaveCount(0);
      await page.getByRole('button', { name: /Focus Lab — session length and timer colour/ }).click();
      const focusLabDialog = page.getByRole('dialog', { name: 'Focus Lab' });
      await expect(focusLabDialog).toBeVisible();
      await waitForFiniteAnimations(focusLabDialog);
      await expectAxeClean(page, `Focus Lab (${theme})`, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(focusLabDialog).toHaveCount(0);

      for (const [path, label] of [
        ['/', 'Today / Planner'],
        ['/tasks', 'Tasks'],
      ] as const) {
        await page.goto(`${url}${path}`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-app-shell]')).toBeVisible();
        await expectAxeClean(page, `${label} (${theme})`);
        if (label === 'Tasks') {
          const addTask = page.locator('button[title="Add to calendar"]');
          await addTask.click();
          const taskDialog = page.getByRole('dialog', { name: 'Add task' });
          await expect(taskDialog).toBeVisible();
          await waitForFiniteAnimations(taskDialog);
          await expectAxeClean(page, `Task editor dialog (${theme})`, '[role="dialog"]');
          await taskDialog.getByRole('button', { name: 'Close task form' }).click();
          await expect(taskDialog).toHaveCount(0);

          await page.goto(`${url}/tasks?tab=objectives`, { waitUntil: 'domcontentloaded' });
          const addObjective = page.getByRole('button', { name: 'New Objective', exact: true });
          await addObjective.click();
          const objectiveDialog = page.getByRole('dialog', { name: 'New Objective' });
          await expect(objectiveDialog).toBeVisible();
          await waitForFiniteAnimations(objectiveDialog);
          await expectAxeClean(page, `Objective editor dialog (${theme})`, '[role="dialog"]');
          await objectiveDialog.getByRole('button', { name: 'Close dialog' }).click();
          await expect(objectiveDialog).toHaveCount(0);
        }
        if (label === 'Today / Planner') {
          const detailsToggle = page.getByRole('button', { name: /details drawer/i }).first();
          if (await detailsToggle.getAttribute('aria-expanded') !== 'true') await detailsToggle.click();
          await page.getByRole('tab', { name: 'Flight Plan' }).click();
          await expect(page.getByRole('region', { name: 'Flight Plan', exact: true })).toBeVisible();
          await expectAxeClean(page, `Flight Plan drawer (${theme})`);
        }
      }
    }
  });

  test('keyboard focus, reduced motion, and larger text preferences remain effective', async ({ page }) => {
    await signInLocal(page, url);
    await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-app-shell]')).toBeVisible();

    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false)).toBe(true);

    const textSize = page.getByLabel('Text size');
    const defaultFontSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    await textSize.selectOption('larger');
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'larger');
    const largerFontSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    expect(parseFloat(largerFontSize)).toBeGreaterThan(parseFloat(defaultFontSize));

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const motion = await page.evaluate(() => {
      const stage = document.createElement('div');
      stage.className = 'focus-stage';
      const animated = document.createElement('div');
      animated.className = 'focus-enter';
      stage.append(animated);
      document.body.append(stage);
      const style = getComputedStyle(animated);
      const state = { preference: matchMedia('(prefers-reduced-motion: reduce)').matches, animation: style.animationName };
      stage.remove();
      return state;
    });
    expect(motion.preference).toBe(true);
    expect(motion.animation).toBe('none');
  });

  test('overdue due-list dialog passes axe in both themes', async ({ page }, testInfo) => {
    test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
    const data = new OwnerFixtures(page.request, testInfo.testId);

    try {
      await signInLocal(page, url);
      const overdueDate = await page.evaluate(() => {
        const date = new Date();
        date.setDate(date.getDate() - 1);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      });
      await data.createTask({ title: `E2E overdue axe ${testInfo.testId}`, due_at: overdueDate });
      await page.addInitScript({ content: axe.source });
      await page.setViewportSize({ width: 430, height: 560 });

      for (const theme of ['light', 'dark'] as const) {
        await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-app-shell]')).toBeVisible();
        await page.getByLabel('Theme mode').selectOption(theme);
        await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
          .toBe(theme === 'dark');

        await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
        const dueButton = page.getByRole('button', { name: 'Due — deadlines for this day' }).first();
        await dueButton.click();
        const dueDialog = page.getByRole('dialog', { name: 'Due list' });
        await expect(dueDialog).toBeVisible();
        await dueDialog.getByTitle('Show overdue tasks').click();
        await waitForFiniteAnimations(dueDialog);
        await expectAxeClean(page, `Overdue due-list dialog (${theme})`, '[role="dialog"]');
        await dueDialog.getByRole('button', { name: 'Close dialog' }).click();
        await expect(dueDialog).toHaveCount(0);
      }
    } finally {
      await data.cleanup();
    }
  });

  test('Planner task details dialog passes axe in both themes', async ({ page }, testInfo) => {
    test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
    const data = new OwnerFixtures(page.request, testInfo.testId);

    try {
      await signInLocal(page, url);
      const day = await page.evaluate(() => {
        const target = new Date();
        target.setDate(target.getDate() + 1);
        const year = target.getFullYear();
        const month = target.getMonth();
        const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
        const start = new Date(year, month, target.getDate(), 10, 0);
        const end = new Date(start.getTime() + 45 * 60_000);
        return { date, startAt: start.toISOString(), endAt: end.toISOString() };
      });
      const task = await data.createTask({ title: `E2E Planner axe ${testInfo.testId}`, estimated_minutes: 45 });
      await data.createBlock({ title: task.title, task_id: task.id, block_kind: 'task', start_at: day.startAt, end_at: day.endAt });
      await page.addInitScript({ content: axe.source });
      await page.setViewportSize({ width: 430, height: 560 });

      for (const theme of ['light', 'dark'] as const) {
        await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-app-shell]')).toBeVisible();
        await page.getByLabel('Theme mode').selectOption(theme);
        await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
          .toBe(theme === 'dark');

        await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
        const dayPicker = page.locator('label[title="Pick a day"] input[type="date"]');
        await dayPicker.fill(day.date);
        const taskBlock = page.locator('div.absolute.z-10').filter({ hasText: task.title }).first();
        await taskBlock.click();
        const details = page.getByRole('dialog', { name: `Task details: ${task.title}` });
        await expect(details).toBeVisible();
        await waitForFiniteAnimations(details);
        await expectAxeClean(page, `Planner task details (${theme})`, '[role="dialog"]');
        await details.getByRole('button', { name: `Close task details` }).click();
        await expect(details).toHaveCount(0);
      }
    } finally {
      await data.cleanup();
    }
  });

  test('mobile primary navigation and assistant button meet 44px touch targets', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInLocal(page, url);
    await page.setViewportSize({ width: 390, height: 844 });

    const navLinks = page.locator('nav.fixed.bottom-0 a');
    await expect(navLinks).toHaveCount(4);
    for (const link of await navLinks.all()) {
      const box = await link.boundingBox();
      expect(box, 'mobile navigation target is rendered').not.toBeNull();
      expect(box!.width, 'mobile navigation target is at least 44px wide').toBeGreaterThanOrEqual(44);
      expect(box!.height, 'mobile navigation target is at least 44px high').toBeGreaterThanOrEqual(44);
    }
    const more = page.getByRole('button', { name: 'More' });
    const moreBox = await more.boundingBox();
    expect(moreBox).not.toBeNull();
    expect(moreBox!.width).toBeGreaterThanOrEqual(44);
    expect(moreBox!.height).toBeGreaterThanOrEqual(44);

    const assistant = page.getByRole('button', { name: 'Talk to task assistant' });
    const fab = await assistant.boundingBox();
    expect(fab, 'task assistant button is rendered').not.toBeNull();
    expect(fab!.width).toBeGreaterThanOrEqual(44);
    expect(fab!.height).toBeGreaterThanOrEqual(44);
  });
});
