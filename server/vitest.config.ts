import { defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test run gets an isolated SQLite file so we never touch the real DB.
const testDbPath = join(tmpdir(), 'companion-planning-test.db');

export default defineConfig({
  test: {
    environment: 'node',
    // Tests share one DB file and reset tables themselves; keep files sequential to avoid write races.
    fileParallelism: false,
    testTimeout: 120_000, // LLM-backed tests can be slow
    hookTimeout: 30_000,
    env: {
      DB_PATH: testDbPath,
      LOG_LEVEL: 'error',
      // Point the Google client at the committed fixtures.
      GOOGLE_MODE: 'fixture',
    },
    include: ['test/**/*.test.ts'],
  },
});
