import { defineConfig } from 'vitest/config';
// Each test run gets an isolated SQLite file so we never touch the real DB.
// Keyed by pid so concurrent runs (e.g. parallel worktrees) never share one DB —
// and deleted before the run opens it, so a recycled pid can't inherit the last
// one. See test/global-setup.ts for why the key stays the pid.
import { testDbPath } from './test/global-setup.js';

export default defineConfig({
  // graphql-js throws "Duplicate graphql modules" if two instances load at once (its
  // instanceof guard). Under vitest's transform pipeline @apollo/server and our own
  // imports can otherwise resolve separate `graphql` copies; dedupe forces the single
  // installed graphql@16. Belt-and-suspenders — the complexity limiter uses graphql
  // directly (no dual-package dep), and prod runs under tsx which caches one instance.
  resolve: { dedupe: ['graphql'] },
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    // Tests share one DB file and reset tables themselves; keep files sequential to avoid write races.
    fileParallelism: false,
    testTimeout: 120_000, // LLM-backed tests can be slow
    // Must clear THREE of helpers.ts's OLLAMA_PROBE_TIMEOUT_MS. The `ollamaAvailable()`
    // gate runs a real fast generation, quality generation and embedding, and several
    // suites spend it from `beforeAll`; a healthy-but-cold box pays each in turn. If this
    // drops below that the hook is killed first and those suites FAIL instead of skipping
    // — the exact outcome the probe exists to prevent. Change the two together or not at
    // all. (An unhealthy box stops at the first failed probe, so it pays one budget.)
    hookTimeout: 150_000,
    env: {
      DB_PATH: testDbPath,
      LOG_LEVEL: 'error',
      // Point the Google client at the committed fixtures.
      GOOGLE_MODE: 'fixture',
    },
    include: ['test/**/*.test.ts'],
  },
});
