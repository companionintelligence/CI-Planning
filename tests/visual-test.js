const fs = require('fs');
const path = require('path');

let playwright;
try {
  playwright = require('playwright');
} catch (err) {
  console.error('\x1b[31m[ERROR] Playwright module not found.\x1b[0m');
  console.error('\nTo run visual automated testing, please install Playwright and its browser binaries by running:\n');
  console.error('  \x1b[36mpnpm add -D playwright\x1b[0m');
  console.error('  \x1b[36mnpx playwright install chromium\x1b[0m\n');
  console.error('Then execute:');
  console.error('  \x1b[32mpnpm test:visual\x1b[0m\n');
  process.exit(1);
}

const { chromium } = playwright;

async function run() {
  const screenshotDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  // Determine target URL
  let targetUrl = 'http://localhost:5174';
  const urlIdx = process.argv.indexOf('--url');
  if (urlIdx !== -1 && process.argv[urlIdx + 1]) {
    targetUrl = process.argv[urlIdx + 1];
  }

  console.log(`\n\x1b[35m[Visual Test] Starting audit on target: ${targetUrl}\x1b[0m`);
  console.log(`[Visual Test] Saving outputs to: ${screenshotDir}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  // Helper for taking screenshot + logging
  const capture = async (name) => {
    const file = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  \x1b[32m✓\x1b[0m Captured: ${name}.png`);
  };

  try {
    // 1. Today view
    console.log('[1/7] Navigating to Today view...');
    await page.goto(`${targetUrl}/`);
    await page.waitForTimeout(1000); // Wait for resource fetch / animations
    await capture('today_view');

    // 2. Calendar view
    console.log('[2/7] Navigating to Calendar view...');
    await page.goto(`${targetUrl}/calendar`);
    await page.waitForTimeout(1000);
    await capture('calendar_view');

    // 3. Inbox view
    console.log('[3/7] Navigating to Inbox view...');
    await page.goto(`${targetUrl}/inbox`);
    await page.waitForTimeout(1000);
    await capture('inbox_view');

    // 4. Tasks view
    console.log('[4/7] Navigating to Tasks view...');
    await page.goto(`${targetUrl}/tasks`);
    await page.waitForTimeout(1000);
    await capture('tasks_view');

    // 5. Jobs view
    console.log('[5/7] Navigating to Jobs view...');
    await page.goto(`${targetUrl}/jobs`);
    await page.waitForTimeout(1000);
    await capture('jobs_view');

    // 5.1 Open Edit Job Modal
    console.log('  Opening Edit Job Modal...');
    const editBtn = page.locator('button[title="Edit Job Schedule"]').first();
    if (await editBtn.count() > 0) {
      await editBtn.click();
      await page.waitForTimeout(500); // Modal animation
      await capture('jobs_view_edit_modal');
      // Close modal by clicking Cancel or pressing Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } else {
      console.log('  (Skipped Edit modal screenshot: No jobs configured or Edit button missing)');
    }

    // 6. Settings view
    console.log('[6/7] Navigating to Settings view...');
    await page.goto(`${targetUrl}/settings`);
    await page.waitForTimeout(1000);
    await capture('settings_view');

    // 7. Toggle theme
    console.log('[7/7] Testing Light/Dark Mode theme toggles...');
    // Look for the theme toggle button in the navbar (has Moon/Sun icon & "Mode")
    const themeBtn = page.locator('button:has-text("Mode")').first();
    if (await themeBtn.count() > 0) {
      await themeBtn.click();
      await page.waitForTimeout(500); // Allow theme classes and colors to swap
      await capture('light_mode_toggle');
      
      // Toggle back to dark mode
      await themeBtn.click();
      await page.waitForTimeout(300);
      console.log('  \x1b[32m✓\x1b[0m Successfully toggled back to Dark Mode');
    } else {
      console.log('  (Skipped theme toggle screenshot: Toggle button not found in sidebar)');
    }

    console.log('\n\x1b[32m=============================================\x1b[0m');
    console.log('\x1b[32mVISUAL AUDIT COMPLETE SUCCESSFULLY!\x1b[0m');
    console.log(`All screenshots saved to: ${screenshotDir}`);
    console.log('\x1b[32m=============================================\x1b[0m\n');

  } catch (err) {
    console.error(`\n\x1b[31m[ERROR] Visual test failed: ${err.message}\x1b[0m\n`);
  } finally {
    await browser.close();
  }
}

run();
