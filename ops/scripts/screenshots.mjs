#!/usr/bin/env node
/**
 * Capture documentation screenshots of every major view from the running app.
 * Uses Playwright with a fresh context (no service-worker cache), so it always
 * shoots the current build.
 *
 * Usage: node ops/scripts/screenshots.mjs [baseURL]
 *   baseURL default http://127.0.0.1:3847  (the server must be running)
 * Output: docs/screenshots/*.png
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const OUT = join(REPO, 'docs', 'screenshots');
const BASE = process.argv[2] || 'http://127.0.0.1:3847';

mkdirSync(OUT, { recursive: true });

const shots = [
  { name: 'today', hash: '#today' },
  { name: 'capacity', hash: '#capacity' },
  { name: 'review', hash: '#review' },
  { name: 'todos', hash: '#todos' },
  { name: 'settings', hash: '#settings' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 920 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// Note: the app holds an open SSE connection (/api/events), so 'networkidle'
// never fires — use 'load' + a fixed settle wait instead.
await page.goto(`${BASE}/#today`, { waitUntil: 'load' });
await page.waitForTimeout(1800);

for (const s of shots) {
  await page.evaluate(h => { location.hash = h; }, s.hash);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: join(OUT, `${s.name}.png`) });
  console.log(`done ${s.name}.png`);
}

await page.evaluate(() => { location.hash = '#todos'; });
await page.waitForTimeout(600);
const fab = page.locator('button[title*="New todo"]').first();
if (await fab.count()) {
  await fab.click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, 'editor.png') });
  console.log('done editor.png');
}

await browser.close();
console.log(`Screenshots written to ${OUT}`);
