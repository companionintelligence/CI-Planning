import { defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test run gets an isolated SQLite file so we never touch the real DB.
// Keyed by pid so concurrent runs (e.g. parallel worktrees) never share one DB.
const testDbPath = join(tmpdir(), `companion-planning-test-${process.pid}.db`);

export default defineConfig({
  // graphql-js throws "Duplicate graphql modules" if two instances load at once (its
  // instanceof guard). Under vitest's transform pipeline @apollo/server and our own
  // imports can otherwise resolve separate `graphql` copies; dedupe forces the single
  // installed graphql@16. Belt-and-suspenders — the complexity limiter uses graphql
  // directly (no dual-package dep), and prod runs under tsx which caches one instance.
  resolve: { dedupe: ['graphql'] },
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
