import { test, expect } from '@playwright/test';
import { signInLocal } from './owner-fixtures.js';

const url = process.env.APP_URL || 'http://localhost:8080';
const username = process.env.LOGIN_USER;
const password = process.env.LOGIN_PASS;

test.use({ viewport: { width: 430, height: 900 } });

test('mobile details, Flight Plan, and assistant switch as viewport-bounded surfaces', async ({ page }) => {
  test.skip(!username || !password, 'requires an authenticated container with LOGIN_USER and LOGIN_PASS');

  await signInLocal(page, url);
  const detailsToggle = page.getByRole('button', { name: /details drawer/i }).first();
  if (await detailsToggle.getAttribute('aria-expanded') !== 'true') await detailsToggle.click();

  const details = page.locator('.details-drawer');
  await expect(details).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to work area' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Flight Plan' })).toBeVisible();
  await page.getByRole('tab', { name: 'Flight Plan' }).click();
  await expect(page.getByRole('tab', { name: 'Flight Plan' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Flight Plan', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Flight Plan actions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Flight Plan is empty' })).toBeVisible();

  const bounds = await details.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(430);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
  await expect(page.getByRole('button', { name: 'Back to work area' })).toBeVisible();

  // A keyboard or browser chrome can shorten the visible area after the sheet opens.
  await page.setViewportSize({ width: 430, height: 560 });
  await expect.poll(async () => (await details.boundingBox())?.y).toBeGreaterThanOrEqual(0);
  const shortBounds = await details.boundingBox();
  expect(shortBounds).not.toBeNull();
  expect(shortBounds!.y + shortBounds!.height).toBeLessThanOrEqual(560);
  await page.setViewportSize({ width: 430, height: 900 });

  // The details header can switch directly to the assistant; the selected drawer tab
  // remains intact and returns when the assistant closes.
  await page.getByRole('button', { name: 'Ask task assistant' }).click();
  const assistant = page.getByRole('dialog', { name: 'Task assistant' });
  await expect(assistant).toBeVisible();
  const assistantBounds = await assistant.boundingBox();
  expect(assistantBounds).not.toBeNull();
  expect(assistantBounds!.x).toBeGreaterThanOrEqual(0);
  expect(assistantBounds!.y).toBeGreaterThanOrEqual(0);
  expect(assistantBounds!.x + assistantBounds!.width).toBeLessThanOrEqual(430);
  expect(assistantBounds!.y + assistantBounds!.height).toBeLessThanOrEqual(900);
  await expect(details).toHaveCount(0);
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await expect(details).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to work area' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Flight Plan' })).toHaveAttribute('aria-selected', 'true');

  // Back closes the sheet without clearing its tab or selection context.
  await page.getByRole('button', { name: 'Back to work area' }).click();
  await expect(details).toHaveCount(0);
  await expect(detailsToggle).toBeFocused();
  await detailsToggle.click();
  await expect(details).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Flight Plan' })).toHaveAttribute('aria-selected', 'true');
});
