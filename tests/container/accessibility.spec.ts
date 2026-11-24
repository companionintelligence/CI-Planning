import { test, expect, type Page } from '@playwright/test';
import axe from 'axe-core';
import { signInLocal } from './owner-fixtures.js';

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
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    }));
  }, { tags: WCAG_TAGS, selector: rootSelector });
  expect(result, `axe WCAG violations on ${surface}`).toEqual([]);
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

      for (const [path, label] of [
        ['/', 'Today / Planner'],
        ['/tasks', 'Tasks'],
      ] as const) {
        await page.goto(`${url}${path}`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-app-shell]')).toBeVisible();
        await expectAxeClean(page, `${label} (${theme})`);
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
