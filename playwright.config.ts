import { defineConfig, devices } from '@playwright/test';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const E2E_PORT = 3848;
const E2E_CONFIG = join(__dirname, 'e2e', 'fixtures', 'config.json');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env['CI'] ? 2 : 0,
  timeout: 30_000,
  reporter: process.env['CI'] ? 'github' : 'list',

  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    command: 'node server/dist/index.js',
    url: `http://127.0.0.1:${E2E_PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 15_000,
    env: {
      COMPANION_CONFIG: E2E_CONFIG,
    },
  },
});
