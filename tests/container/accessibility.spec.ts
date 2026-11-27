import { test, expect, type Page } from '@playwright/test';
import axe from 'axe-core';
import { OwnerFixtures, signInLocal } from './owner-fixtures.js';
import { createDayReflowFixture, selectFocusDate } from './day-reflow-fixture.js';

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
    const animations = new Set<Animation>();
    for (let node: Element | null = element; node; node = node.parentElement) {
      for (const animation of node.getAnimations({ subtree: node === element })) animations.add(animation);
    }
    const finite = [...animations].filter((animation) =>
      Number.isFinite(animation.effect?.getComputedTiming().iterations ?? 1),
    );
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
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
      await expect(page.getByRole('heading', { name: 'Focus' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Focus actions' })).toBeVisible();
      await expectAxeClean(page, `Focus view (${theme})`);
      await page.goto(`${url}/calendar`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('group', { name: 'Calendar quick actions' })).toBeVisible();
      await expectAxeClean(page, `Calendar view (${theme})`);
      await page.getByRole('button', { name: 'Plan my week' }).click();
      const planWeekDialog = page.getByRole('dialog', { name: 'Plan my week' });
      await expect(planWeekDialog).toBeVisible();
      await waitForFiniteAnimations(planWeekDialog);
      await expectAxeClean(page, `Plan my week dialog (${theme})`, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(planWeekDialog).toHaveCount(0);
      await page.goto(`${url}/tasks`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Bulk add' }).click();
      const bulkDialog = page.getByRole('dialog', { name: 'Add tasks in bulk' });
      await expect(bulkDialog).toBeVisible();
      await waitForFiniteAnimations(bulkDialog);
      await expectAxeClean(page, `Bulk task input dialog (${theme})`, '[role="dialog"]');
      await bulkDialog.getByRole('textbox', { name: 'Task list' }).fill('First draft\nSecond draft');
      await bulkDialog.getByRole('button', { name: 'Create drafts' }).click();
      await expectAxeClean(page, `Bulk task review dialog (${theme})`, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(bulkDialog).toHaveCount(0);
      await page.goto(`${url}/tasks?tab=routines`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Manage types' }).click();
      const patternTypesDialog = page.getByRole('dialog', { name: 'Pattern types' });
      await expect(patternTypesDialog).toBeVisible();
      await waitForFiniteAnimations(patternTypesDialog);
      await expectAxeClean(page, `Pattern types dialog (${theme})`, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(patternTypesDialog).toHaveCount(0);
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

  test('task reflection dialog passes axe in both themes', async ({ page }, testInfo) => {
    await signInLocal(page, url);
    await page.addInitScript({ content: axe.source });
    const data = new OwnerFixtures(page.request, testInfo.testId);

    try {
      for (const theme of ['light', 'dark'] as const) {
        const task = await data.createTask({ title: `A11y reflection ${theme} ${testInfo.testId}` });
        await page.goto(`${url}/tasks?task=${encodeURIComponent(task.id)}`, { waitUntil: 'domcontentloaded' });
        await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        const card = page.locator('.task-card').filter({ hasText: task.title });
        await expect(card).toBeVisible();
        await card.locator('button[title="Mark done"]').click();
        const dialog = page.getByRole('dialog', { name: `Task reflection: ${task.title}` });
        await expect(dialog).toBeVisible();
        await waitForFiniteAnimations(dialog);
        await expectAxeClean(page, `Task reflection dialog (${theme})`, '[role="dialog"]');
        await dialog.getByTitle('Skip — the task stays done').click();
        await expect(dialog).toHaveCount(0);
      }
    } finally {
      await data.cleanup();
    }
  });

  test('mobile details sheet uses the modal contract in both themes', async ({ page }) => {
    await signInLocal(page, url);
    await page.addInitScript({ content: axe.source });
    await page.setViewportSize({ width: 430, height: 560 });

    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-app-shell]')).toBeVisible();
      await page.getByLabel('Theme mode').selectOption(theme);
      await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
        .toBe(theme === 'dark');

      await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
      const opener = page.getByRole('button', { name: /details drawer/i }).first();
      if (await opener.getAttribute('aria-expanded') !== 'true') await opener.click();
      const dialog = page.getByRole('dialog', { name: /^Details:/ });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Back to work area' })).toBeFocused();
      await waitForFiniteAnimations(dialog);
      await expectAxeClean(page, `Details sheet (${theme})`, '[role="dialog"]');

      const bounds = await dialog.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: window.visualViewport?.width ?? window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
      }));
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);

      // The dialog owns Tab cycling, Escape and opener restoration on mobile.
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();

      await opener.click();
      const reopenedDialog = page.getByRole('dialog', { name: /^Details:/ });
      await expect(reopenedDialog).toBeVisible();
      await page.locator('.mobile-details-backdrop').click({ position: { x: 2, y: 2 } });
      await expect(reopenedDialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });

  test('conditional reminder and Time-Sense Settings states pass axe in both themes', async ({ page }) => {
    await signInLocal(page, url);
    await page.addInitScript({ content: axe.source });
    await page.setViewportSize({ width: 430, height: 560 });

    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-app-shell]')).toBeVisible();
      await page.getByLabel('Theme mode').selectOption(theme);
      await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
        .toBe(theme === 'dark');

      const advanceReminder = page.getByRole('switch', { name: 'Advance reminder' });
      await advanceReminder.click();
      await expect(page.getByText('minutes before start')).toBeVisible();
      await expectAxeClean(page, `Conditional reminder Settings (${theme})`);

      const timeSense = page.getByRole('switch', { name: 'Time-Sense' });
      await timeSense.click();
      await expect(page.getByRole('switch', { name: 'Focus screen' })).toBeVisible();
      await expect(page.getByRole('switch', { name: 'Haptic cues' })).toBeVisible();
      await expect(page.getByRole('switch', { name: 'Calibration nudge' })).toBeVisible();
      await expectAxeClean(page, `Time-Sense conditional Settings (${theme})`);
    }
  });

  test('Create Routine sheet passes axe in both themes', async ({ page }, testInfo) => {
    const data = new OwnerFixtures(page.request, testInfo.testId);

    try {
      await signInLocal(page, url);
      const day = await page.evaluate(() => {
        const target = new Date();
        target.setDate(target.getDate() + 1);
        const date = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
        const start = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 10, 0);
        return { date, first: start.toISOString(), second: new Date(start.getTime() + 60 * 60_000).toISOString() };
      });
      for (let i = 0; i < 2; i++) {
        const task = await data.createTask({ title: `E2E routine axe ${i} ${testInfo.testId}` });
        const start = i === 0 ? day.first : day.second;
        await data.createBlock({
          title: task.title, task_id: task.id, block_kind: 'task', start_at: start,
          end_at: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
        });
      }
      await page.addInitScript({ content: axe.source });
      await page.setViewportSize({ width: 430, height: 560 });

      for (const theme of ['light', 'dark'] as const) {
        await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-app-shell]')).toBeVisible();
        await page.getByLabel('Theme mode').selectOption(theme);
        await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
          .toBe(theme === 'dark');

        await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
        await page.getByTitle('Pick a day').locator('input[type="date"]').fill(day.date);
        for (let i = 0; i < 2; i++) {
          const title = `E2E routine axe ${i} ${testInfo.testId}`;
          const chip = page.getByTitle(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ·`));
          await expect(chip).toBeVisible();
          await chip.click({ modifiers: ['Control'] });
        }
        const quickActions = page.getByRole('button', { name: 'Planner quick actions' });
        await quickActions.click();
        await page.getByRole('button', { name: /\+ Routine/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Create Routine from 2 items' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('textbox', { name: 'Routine name' })).toBeFocused();
        await waitForFiniteAnimations(dialog);
        await expectAxeClean(page, `Create Routine dialog (${theme})`, '[role="dialog"]');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await page.keyboard.press('Escape'); // Clear the multi-select after closing its sheet.
      }
    } finally {
      await data.cleanup();
    }
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

  test('day reflow dialog passes axe in both themes', async ({ page }, testInfo) => {
    test.skip(!username || !password, 'requires a local-login container with LOGIN_USER and LOGIN_PASS');
    await signInLocal(page, url);
    const scenario = await createDayReflowFixture(page, testInfo);

    try {
      await page.addInitScript({ content: axe.source });
      await page.setViewportSize({ width: 430, height: 560 });

      for (const theme of ['light', 'dark'] as const) {
        await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-app-shell]')).toBeVisible();
        await page.getByLabel('Theme mode').selectOption(theme);
        await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
          .toBe(theme === 'dark');

        await selectFocusDate(page, scenario.date);
        const opener = page.getByRole('button', { name: 'Reschedule all' });
        await opener.click();
        const dialog = page.getByRole('dialog', { name: 'Reschedule conflicting tasks' });
        await expect(dialog).toBeVisible();
        await waitForFiniteAnimations(dialog);
        await expectAxeClean(page, `Day reflow dialog (${theme})`, '[role="dialog"]');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }
    } finally {
      await scenario.cleanup();
    }
  });

  test('Automation dialog passes axe in both themes', async ({ page }) => {
    await signInLocal(page, url);
    await page.addInitScript({ content: axe.source });
    await page.setViewportSize({ width: 430, height: 560 });

    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-app-shell]')).toBeVisible();
      await page.getByLabel('Theme mode').selectOption(theme);
      await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
        .toBe(theme === 'dark');

      await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
      const opener = page.getByRole('button', { name: /^Automation level:/ });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Automation' });
      await expect(dialog).toBeVisible();
      await waitForFiniteAnimations(dialog);
      await expectAxeClean(page, `Automation dialog (${theme})`, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });

  test('Texture settings dialog passes axe in both themes', async ({ page }) => {
    await signInLocal(page, url);
    await page.addInitScript({ content: axe.source });
    await page.setViewportSize({ width: 430, height: 560 });

    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-app-shell]')).toBeVisible();
      await page.getByLabel('Theme mode').selectOption(theme);
      await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
        .toBe(theme === 'dark');

      await page.goto(`${url}/tasks`, { waitUntil: 'domcontentloaded' });
      await page.locator('button[title="Add to calendar"]').click();
      const taskDialog = page.getByRole('dialog', { name: 'Add task' });
      await expect(taskDialog).toBeVisible();
      await taskDialog.getByPlaceholder('Task title…').fill('Texture accessibility fixture');
      await taskDialog.getByRole('button', { name: /^Texture:/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Texture' });
      await expect(dialog).toBeVisible();
      await waitForFiniteAnimations(dialog);
      await expectAxeClean(page, `Texture settings dialog (${theme})`, '[role="dialog"]:has(h2)');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(taskDialog.getByRole('button', { name: /^Texture:/ })).toBeFocused();
      await taskDialog.getByRole('button', { name: 'Close task form' }).click();
    }
  });

  test('Recurring scope dialog passes axe in both themes', async ({ page }, testInfo) => {
    const data = new OwnerFixtures(page.request, testInfo.testId);

    try {
      await signInLocal(page, url);
      const title = `E2E recurring block axe ${testInfo.testId} ${Date.now()}`;
      const { start_at, end_at } = await page.evaluate(() => {
        const start = new Date();
        start.setHours(10, 0, 0, 0);
        return { start_at: start.toISOString(), end_at: new Date(start.getTime() + 30 * 60_000).toISOString() };
      });
      await data.createRecurringBlock({ title, start_at, end_at, block_kind: 'timeblock', recurrence_rule: 'FREQ=DAILY;COUNT=3' });
      await page.addInitScript({ content: axe.source });
      await page.setViewportSize({ width: 430, height: 560 });

      for (const theme of ['light', 'dark'] as const) {
        await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-app-shell]')).toBeVisible();
        await page.getByLabel('Theme mode').selectOption(theme);
        await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
          .toBe(theme === 'dark');

        await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
        const block = page.locator(`div[title^="${title} · Time Block"]`);
        const opener = block.getByTitle('Remove Time Block');
        await expect(opener).toBeVisible();
        await opener.click();
        const dialog = page.getByRole('dialog', { name: `Delete repeating item: ${title}` });
        await expect(dialog).toBeVisible();
        await waitForFiniteAnimations(dialog);
        await expectAxeClean(page, `Recurring scope dialog (${theme})`, '[role="dialog"][aria-label^="Delete repeating item:"]');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
      }
    } finally {
      await data.cleanup();
    }
  });

  test('Task assistant stays within a short mobile viewport and passes axe in both themes', async ({ page }) => {
    await signInLocal(page, url);
    await page.addInitScript({ content: axe.source });
    await page.setViewportSize({ width: 430, height: 560 });

    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-app-shell]')).toBeVisible();
      await page.getByLabel('Theme mode').selectOption(theme);
      await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
        .toBe(theme === 'dark');

      await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
      const opener = page.getByRole('button', { name: 'Talk to task assistant' });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Task assistant' });
      await expect(dialog).toBeVisible();
      await waitForFiniteAnimations(dialog);
      await expectAxeClean(page, `Task assistant (${theme})`, '[role="dialog"][aria-label="Task assistant"]');

      const shortBounds = await dialog.boundingBox();
      expect(shortBounds).not.toBeNull();
      expect(shortBounds!.x).toBeGreaterThanOrEqual(0);
      expect(shortBounds!.y).toBeGreaterThanOrEqual(0);
      expect(shortBounds!.x + shortBounds!.width).toBeLessThanOrEqual(430);
      expect(shortBounds!.y + shortBounds!.height).toBeLessThanOrEqual(560);
      await expect(dialog.getByRole('button', { name: 'Close assistant' })).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });

  test('mobile primary navigation and assistant button meet 44px touch targets', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await signInLocal(page, url);
    await page.addInitScript({ content: axe.source });
    await page.setViewportSize({ width: 320, height: 568 });

    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`${url}/settings?tab=preferences`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Theme mode').selectOption(theme);
      await expect.poll(async () => /\bdark\b/.test((await page.locator('html').getAttribute('class')) ?? ''))
        .toBe(theme === 'dark');
      await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
      await expectAxeClean(page, `320px mobile navigation (${theme})`, 'nav.fixed.bottom-0');

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
    }
  });
});
